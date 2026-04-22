// Cloudbeds is a Single Page Application (SPA), so we must observe mutations to see when a reservation opens.

let injectionAttempted = false;

function injectTabletButton() {
    // Look for a known Cloudbeds element in the reservation slide-out or page
    // Often reservation IDs are in the URL hash like: #/reservations/123456
    const hash = window.location.hash;
    const resMatch = hash.match(/\/reservations\/(\d+)/) || hash.match(/\/reservation\/(\d+)/);
    
    if (!resMatch) {
       // We are not on a reservation page
       removeTabletButton();
       return;
    }

    const reservationId = resMatch[1];

    if (document.getElementById('cloudbeds-kiosk-push-btn')) {
        // Already injected, just update the dataset ID in case URL changed
        document.getElementById('cloudbeds-kiosk-push-btn').dataset.resId = reservationId;
        return;
    }

    // Create the floating button
    const btn = document.createElement("button");
    btn.id = "cloudbeds-kiosk-push-btn";
    btn.dataset.resId = reservationId;
    btn.innerText = "📲 Push to Tablet";

    // Styling to look native but float in the bottom right corner
    Object.assign(btn.style, {
        position: 'fixed',
        bottom: '30px',
        right: '30px',
        zIndex: '999999',
        backgroundColor: '#007BFF',
        color: '#FFFFFF',
        border: 'none',
        borderRadius: '50px',
        padding: '12px 24px',
        fontSize: '14px',
        fontWeight: 'bold',
        boxShadow: '0px 4px 6px rgba(0,0,0,0.2)',
        cursor: 'pointer',
        transition: 'all 0.3s ease'
    });

    btn.addEventListener('mouseenter', () => { btn.style.backgroundColor = '#0056b3'; });
    btn.addEventListener('mouseleave', () => { btn.style.backgroundColor = '#007BFF'; });

    btn.addEventListener('click', () => {
        const id = btn.dataset.resId;
        btn.innerText = 'Pushing...';
        
        // Ping our local Autonomy Engine server
        fetch('http://10.25.25.39:3000/api/kiosk/push', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reservationId: id })
        })
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                btn.innerText = '✅ Tablet Synced!';
                btn.style.backgroundColor = '#28a745';
                setTimeout(() => {
                    btn.innerText = "📲 Push to Tablet";
                    btn.style.backgroundColor = '#007BFF';
                }, 3000);
            } else {
                alert("Failed to sync to tablet: " + data.error);
                btn.innerText = "📲 Push to Tablet";
            }
        })
        .catch(err => {
            alert("Local Autonomy server unreachable. Make sure node server.js is running.");
            btn.innerText = "📲 Push to Tablet";
        });
    });

    document.body.appendChild(btn);
}

function removeTabletButton() {
    const btn = document.getElementById('cloudbeds-kiosk-push-btn');
    if (btn) btn.remove();
}

// Observe URL changes natively inside the Cloudbeds SPA
let lastUrl = location.href; 
new MutationObserver(() => {
  const url = location.href;
  if (url !== lastUrl) {
    lastUrl = url;
    injectTabletButton();
  }
}).observe(document, {subtree: true, childList: true});

// Initial injection try
setInterval(injectTabletButton, 2000);
