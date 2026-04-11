const fs = require('fs');
const path = require('path');

class Logger {
  constructor() {
    this.logDir = path.join(__dirname, '..', 'logs');
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
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

  info(...args) { this._write('INFO', ...args); }
  warn(...args) { this._write('WARN', ...args); }
  error(...args) { this._write('ERROR', ...args); }
  debug(...args) { this._write('DEBUG', ...args); }
}

const logger = new Logger();
module.exports = { logger };
