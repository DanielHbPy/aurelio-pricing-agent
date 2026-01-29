/**
 * Aurelio Combined Entry Point
 *
 * Runs both the Aurelio daemon (price scraping + analysis)
 * and the Dashboard web server on a single Railway service.
 *
 * Usage: node index.mjs
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log(`
╔══════════════════════════════════════════════════════════════════╗
║                                                                  ║
║   AURELIO - Pricing Intelligence System                          ║
║   HidroBio S.A.                                                  ║
║                                                                  ║
║   Starting services:                                             ║
║   1. Aurelio Daemon (scraping + analysis)                        ║
║   2. Dashboard Server (web interface)                            ║
║                                                                  ║
╚══════════════════════════════════════════════════════════════════╝
`);

// Start Aurelio daemon
const daemonPath = path.join(__dirname, 'aurelio.mjs');
const daemon = spawn('node', [daemonPath, '--daemon'], {
  cwd: __dirname,
  stdio: 'inherit',
  env: { ...process.env }
});

console.log('[Main] Started Aurelio daemon (PID: ' + daemon.pid + ')');

// Start Dashboard server
const dashboardPath = path.join(__dirname, 'dashboard', 'server.js');
const dashboard = spawn('node', [dashboardPath], {
  cwd: path.join(__dirname, 'dashboard'),
  stdio: 'inherit',
  env: {
    ...process.env,
    DASHBOARD_PORT: process.env.DASHBOARD_PORT || process.env.PORT || '3000'
  }
});

console.log('[Main] Started Dashboard server (PID: ' + dashboard.pid + ')');

// Handle process termination
function cleanup() {
  console.log('\n[Main] Shutting down services...');

  if (daemon && !daemon.killed) {
    daemon.kill('SIGTERM');
    console.log('[Main] Stopped Aurelio daemon');
  }

  if (dashboard && !dashboard.killed) {
    dashboard.kill('SIGTERM');
    console.log('[Main] Stopped Dashboard server');
  }

  process.exit(0);
}

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

// Monitor child processes
daemon.on('exit', (code) => {
  console.log(`[Main] Aurelio daemon exited with code ${code}`);
  if (code !== 0 && code !== null) {
    console.log('[Main] Restarting daemon in 5 seconds...');
    setTimeout(() => {
      const newDaemon = spawn('node', [daemonPath, '--daemon'], {
        cwd: __dirname,
        stdio: 'inherit',
        env: { ...process.env }
      });
      console.log('[Main] Restarted Aurelio daemon (PID: ' + newDaemon.pid + ')');
    }, 5000);
  }
});

dashboard.on('exit', (code) => {
  console.log(`[Main] Dashboard server exited with code ${code}`);
  if (code !== 0 && code !== null) {
    console.log('[Main] Restarting dashboard in 5 seconds...');
    setTimeout(() => {
      const newDashboard = spawn('node', [dashboardPath], {
        cwd: path.join(__dirname, 'dashboard'),
        stdio: 'inherit',
        env: {
          ...process.env,
          DASHBOARD_PORT: process.env.DASHBOARD_PORT || process.env.PORT || '3000'
        }
      });
      console.log('[Main] Restarted Dashboard server (PID: ' + newDashboard.pid + ')');
    }, 5000);
  }
});

// Keep the process alive
setInterval(() => {
  const now = new Date().toLocaleString('es-PY', { timeZone: 'America/Asuncion' });
  console.log(`[Main] Heartbeat: ${now} - Daemon: ${daemon.killed ? 'stopped' : 'running'}, Dashboard: ${dashboard.killed ? 'stopped' : 'running'}`);
}, 3600000); // Hourly heartbeat
