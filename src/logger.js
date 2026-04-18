const fs = require('fs');
const path = require('path');

class Logger {
  constructor() {
    this.logDir = path.join(__dirname, '..', 'logs');
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
    this.feed = []; // Bounded array for non-technical staff dashboard
  }

  _timestamp() {
    return new Date().toISOString();
  }

  _write(level, ...args) {
    const message = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : a)).join(' ');
    const line = `[${this._timestamp()}] [${level}] ${message}`;
    console.log(line);

    const logFile = path.join(this.logDir, `${new Date().toISOString().split('T')[0]}.log`);
    fs.appendFile(logFile, line + '\n', (err) => {
      if (err) console.error('Failed to write to log file:', err);
    });
  }

  // Activity Feed hook for Front-End Staff Portal
  action(category, summary, status = "ok") {
    this.feed.unshift({ timestamp: this._timestamp(), category, summary, status });
    if (this.feed.length > 50) this.feed.pop(); // Keep bounded to last 50 events
    
    // Fallback pass directly out to raw logs
    this._write(status === "error" ? 'ERROR' : 'INFO', `[${category.toUpperCase()}] ${summary}`);
  }

  getFeed() {
    return this.feed;
  }

  info(...args) { this._write('INFO', ...args); }
  warn(...args) { this._write('WARN', ...args); }
  error(...args) { this._write('ERROR', ...args); }
  debug(...args) { this._write('DEBUG', ...args); }
}

const logger = new Logger();
module.exports = { logger };
