const { logger } = require('./logger');

/**
 * Deterministic, non-LLM nightly room assignment.
 *
 * Why this isn't the agent:
 *
 * The 3:00 AM cron previously handed a free-form prompt to Gemini and
 * expected it to chain getReservations → getUnassignedRooms → a sequence
 * of assignRoom calls. Empirically the model would assign one or two
 * rooms and then declare the task complete in its summary, leaving most
 * arrivals unplaced. LLMs are unreliable for batch matching with strict
 * id correctness across many calls — this is exactly the work to lift
 * off the model.
 *
 * Algorithm (pure JS):
 *   1. Pull reservations arriving today.
 *   2. Filter to status='confirmed' and walk each guestList room slot;
 *      collect every slot that is missing roomID but has roomTypeID.
 *   3. Pull the property-wide pool of available physical rooms for
 *      [today, tomorrow].
 *   4. Group the pool by roomTypeID.
 *   5. For each unassigned slot, pop a room of the matching type and
 *      call assignRoom. If no room of the right type is available, add
 *      to the "couldn't place" list (operator must roll the type or
 *      walk the guest).
 *   6. Alert the front desk on any unplaced or errored assignment so
 *      morning shift sees the issue when they walk in, not whenever
 *      the guest does.
 *
 * The agent's `assignRoom` tool is unchanged and still available for
 * ad-hoc reassignment requests via chat — it's just no longer the
 * batch path.
 */
async function runRoomAssignment({ api, alertHub, todayStr, tomorrowStr }) {
  logger.info(`[ROOM ASSIGN] Starting deterministic assignment for ${todayStr}.`);

  // 1. Today's arrivals.
  const reservationsResp = await api.getReservations(todayStr, todayStr);
  if (!reservationsResp || !reservationsResp.success) {
    logger.error(`[ROOM ASSIGN] getReservations failed; aborting.`);
    if (alertHub) {
      alertHub.publish({
        urgency: 'high',
        issueDescription: `Nightly room assignment aborted — could not fetch today's arrivals from Cloudbeds. Check the engine log around 3:00 AM and reassign manually.`
      });
    }
    return { assigned: 0, attempted: 0, unplaced: [], errors: ['getReservations failed'] };
  }
  const arrivals = reservationsResp.data || [];

  // 2. Walk every room slot on every confirmed arrival; collect the
  //    slots that have a roomTypeID but no roomID yet.
  const needAssignment = [];
  for (const r of arrivals) {
    const status = (r.status || '').toLowerCase();
    if (status !== 'confirmed') continue;
    if (!r.guestList) continue;
    const reservationFallbackTypeId = r.roomTypeID || r.roomTypeId || null;
    for (const g of Object.values(r.guestList)) {
      if (!g || !Array.isArray(g.rooms)) continue;
      for (const rm of g.rooms) {
        if (!rm) continue;
        if (rm.roomID) continue; // already placed
        const wantedTypeId = rm.roomTypeID || rm.roomTypeId || reservationFallbackTypeId;
        if (!wantedTypeId) {
          logger.warn(`[ROOM ASSIGN] Reservation ${r.reservationID} has an unassigned slot with no roomTypeID — skipping; cannot match.`);
          continue;
        }
        needAssignment.push({
          reservationId: r.reservationID,
          guestName: (r.guestName || `${g.firstName || ''} ${g.lastName || ''}`.trim() || 'Guest').toString(),
          roomTypeID: wantedTypeId,
          roomTypeName: rm.roomTypeName || rm.roomType || ''
        });
      }
    }
  }

  if (needAssignment.length === 0) {
    logger.info(`[ROOM ASSIGN] No unassigned arrivals for ${todayStr}; nothing to do.`);
    return { assigned: 0, attempted: 0, unplaced: [], errors: [] };
  }
  logger.info(`[ROOM ASSIGN] ${needAssignment.length} unassigned arrival${needAssignment.length === 1 ? '' : 's'} to place.`);

  // 3. Available physical rooms.
  const unassignedResp = await api.getUnassignedRooms(todayStr, tomorrowStr);
  if (!unassignedResp || !unassignedResp.success) {
    logger.error(`[ROOM ASSIGN] getUnassignedRooms failed; aborting.`);
    if (alertHub) {
      alertHub.publish({
        urgency: 'high',
        issueDescription: `Nightly room assignment aborted — could not fetch the available-room pool from Cloudbeds. Reassign manually.`
      });
    }
    return { assigned: 0, attempted: needAssignment.length, unplaced: needAssignment, errors: ['getUnassignedRooms failed'] };
  }

  // 4. Pool by roomTypeID.
  const poolByType = new Map();
  for (const room of unassignedResp.data || []) {
    if (!room.roomTypeID) continue;
    if (!poolByType.has(room.roomTypeID)) poolByType.set(room.roomTypeID, []);
    poolByType.get(room.roomTypeID).push(room);
  }
  if (poolByType.size > 0) {
    const summary = [...poolByType.entries()]
      .map(([t, list]) => `${list.length}×${list[0].roomType || t}`)
      .join(', ');
    logger.info(`[ROOM ASSIGN] Available pool: ${summary}.`);
  } else {
    logger.warn(`[ROOM ASSIGN] Available pool is empty — every arrival will go unplaced.`);
  }

  // 5. Pair-and-place.
  let assigned = 0;
  const unplaced = [];
  const errors = [];
  for (const need of needAssignment) {
    const pool = poolByType.get(need.roomTypeID);
    if (!pool || pool.length === 0) {
      logger.warn(`[ROOM ASSIGN] No available room of type ${need.roomTypeName || need.roomTypeID} for ${need.guestName} (${need.reservationId}).`);
      unplaced.push(need);
      continue;
    }
    const room = pool.shift();
    try {
      const result = await api.assignRoom(need.reservationId, room.roomId, need.roomTypeID);
      if (result && result.success !== false) {
        logger.info(`[ROOM ASSIGN] Assigned ${need.guestName} (${need.reservationId}) → Room ${room.roomName} [${room.roomId}].`);
        assigned++;
      } else {
        const msg = (result && (result.message || result.error)) || 'unknown error';
        logger.error(`[ROOM ASSIGN] assignRoom rejected for ${need.guestName} (${need.reservationId}): ${msg}`);
        // Put the room back in the pool — the next reservation of the
        // same type might succeed where this one didn't (e.g. room was
        // wrong on Cloudbeds' side, not this assignment's).
        pool.unshift(room);
        errors.push({ ...need, error: msg });
      }
    } catch (e) {
      logger.error(`[ROOM ASSIGN] assignRoom threw for ${need.guestName} (${need.reservationId}): ${e.message}`);
      pool.unshift(room);
      errors.push({ ...need, error: e.message });
    }
  }

  // 6. Alert if anything's broken or unplaced.
  if ((unplaced.length > 0 || errors.length > 0) && alertHub) {
    const lines = [`Auto-assigned ${assigned}/${needAssignment.length} arrival${needAssignment.length === 1 ? '' : 's'} for ${todayStr}.`];
    if (unplaced.length > 0) {
      lines.push(`${unplaced.length} could not be placed (no matching type available):`);
      for (const u of unplaced.slice(0, 6)) {
        lines.push(`  • ${u.guestName} (${u.reservationId}) — ${u.roomTypeName || u.roomTypeID}`);
      }
      if (unplaced.length > 6) lines.push(`  • …and ${unplaced.length - 6} more`);
    }
    if (errors.length > 0) {
      lines.push(`${errors.length} assignment${errors.length === 1 ? '' : 's'} failed:`);
      for (const e of errors.slice(0, 6)) {
        lines.push(`  • ${e.guestName} (${e.reservationId}): ${(e.error || '').substring(0, 80)}`);
      }
    }
    alertHub.publish({
      urgency: 'high',
      issueDescription: lines.join(' ')
    });
  }

  logger.info(`[ROOM ASSIGN] Done: ${assigned}/${needAssignment.length} placed; ${unplaced.length} unplaced; ${errors.length} errored.`);
  return { assigned, attempted: needAssignment.length, unplaced, errors };
}

module.exports = { runRoomAssignment };
