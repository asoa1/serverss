import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} from '@whiskeysockets/baileys';

import express from 'express';
import cors from 'cors';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Web server setup
const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Create a proper minimal logger that satisfies Baileys
const createMinimalLogger = () => {
  const noop = () => {};
  const logger = {
    level: 'silent',
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => logger // Return the same logger instance
  };
  return logger;
};

// Store multiple users and their pairing codes
const userSessions = new Map();
const PENDING_EXPIRY = 10 * 60 * 1000; // 10 minutes

// Generate unique session ID
const generateSessionId = () => {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
};

// Generate session name
const generateSessionName = (sessionId) => {
  return `ICEY_MD_${sessionId.substring(0, 8).toUpperCase()}`;
};

// Clean up expired sessions
const cleanupExpiredSessions = () => {
  const now = Date.now();
  for (const [sessionId, session] of userSessions.entries()) {
    if (now - session.createdAt > PENDING_EXPIRY) {
      userSessions.delete(sessionId);
      console.log(chalk.gray(`🧹 Cleaned up expired session: ${sessionId}`));
    }
  }
};

// Run cleanup every minute
setInterval(cleanupExpiredSessions, 60 * 1000);

// Function to export credentials as session string
function exportSessionString(creds) {
  try {
    const sessionData = {
      clientID: creds.clientID,
      serverToken: creds.serverToken,
      clientToken: creds.clientToken,
      encKey: creds.encKey ? creds.encKey.toString('base64') : null,
      macKey: creds.macKey ? creds.macKey.toString('base64') : null,
      pairingCode: creds.pairingCode,
      me: creds.me,
      account: creds.account,
      registration: creds.registration,
    };
    
    return Buffer.from(JSON.stringify(sessionData)).toString('base64');
  } catch (error) {
    console.error('Error exporting session string:', error);
    return null;
  }
}

// Function to save session to file
function saveSessionToFile(sessionId, sessionString, number, sessionName) {
  const sessionsDir = path.join(__dirname, 'sessions');
  if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true });
  }
  
  const sessionFile = path.join(sessionsDir, `${sessionId}.json`);
  const sessionData = {
    sessionId,
    sessionString,
    sessionName,
    number,
    createdAt: new Date().toISOString(),
    exportedAt: new Date().toISOString()
  };
  
  fs.writeFileSync(sessionFile, JSON.stringify(sessionData, null, 2));
  console.log(chalk.green(`💾 Session saved to: ${sessionFile}`));
}

// API endpoint to receive number from webpage
app.post('/api/number', async (req, res) => {
  const { number } = req.body;
  
  if (!number) {
    return res.status(400).json({ error: 'Number is required' });
  }

  const sessionId = generateSessionId();
  const sessionName = generateSessionName(sessionId);
  
  userSessions.set(sessionId, {
    number: number.trim(),
    sessionId,
    sessionName,
    createdAt: Date.now(),
    isProcessed: false,
    pairingCode: null,
    codeGeneratedAt: null,
    sessionString: null,
    isConnected: false,
    status: 'waiting'
  });

  console.log(chalk.green(`📱 New request from session ${sessionId}: ${number}`));
  console.log(chalk.blue(`🏷️ Session Name: ${sessionName}`));
  
  // Start pairing process
  startWhatsAppConnection(sessionId);
  
  res.json({ 
    success: true, 
    message: 'Number received successfully',
    sessionId,
    sessionName
  });
});

// API endpoint to get pairing code (long polling)
app.get('/api/pairing-code/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const session = userSessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found or expired' });
  }

  if (session.pairingCode) {
    return res.json({ 
      code: session.pairingCode, 
      available: true, 
      sessionId,
      sessionName: session.sessionName,
      isConnected: session.isConnected,
      sessionString: session.sessionString 
    });
  }

  // Wait for pairing code with timeout
  const waitForCode = () => {
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        const currentSession = userSessions.get(sessionId);
        if (!currentSession) {
          clearInterval(checkInterval);
          resolve({ error: 'Session expired' });
        } else if (currentSession.pairingCode) {
          clearInterval(checkInterval);
          resolve({ 
            code: currentSession.pairingCode, 
            available: true,
            sessionName: currentSession.sessionName,
            isConnected: currentSession.isConnected,
            sessionString: currentSession.sessionString
          });
        } else if (currentSession.status === 'error') {
          clearInterval(checkInterval);
          resolve({ error: 'Failed to generate pairing code' });
        }
      }, 1000);
    });
  };

  const timeoutPromise = new Promise((resolve) => {
    setTimeout(() => resolve({ timeout: true }), 60000);
  });

  const result = await Promise.race([waitForCode(), timeoutPromise]);
  
  if (result.timeout) {
    res.json({ available: false, message: 'No code available yet' });
  } else if (result.error) {
    res.status(404).json({ error: result.error });
  } else {
    res.json({ ...result, sessionId });
  }
});

// API endpoint to check session status
app.get('/api/session/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = userSessions.get(sessionId);
  
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  res.json({
    number: session.number,
    sessionName: session.sessionName,
    createdAt: session.createdAt,
    hasPairingCode: !!session.pairingCode,
    isProcessed: session.isProcessed,
    isConnected: session.isConnected,
    hasSessionString: !!session.sessionString,
    status: session.status,
    age: Date.now() - session.createdAt
  });
});

// API endpoint to get statistics
app.get('/api/stats', (req, res) => {
  const activeSessions = Array.from(userSessions.values()).filter(
    session => Date.now() - session.createdAt < PENDING_EXPIRY
  );
  
app.get('/api/session-data/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = userSessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  if (!session.sessionString) {
    return res.status(400).json({ error: 'Session not connected yet' });
  }

  res.json({
    sessionId: session.sessionId,
    sessionName: session.sessionName,
    number: session.number,
    sessionString: session.sessionString,
    createdAt: session.createdAt,
    exportedAt: new Date().toISOString()
  });
});

  const waitingCount = activeSessions.filter(s => s.status === 'waiting').length;
  const processingCount = activeSessions.filter(s => s.status === 'processing').length;
  const connectedCount = activeSessions.filter(s => s.isConnected).length;
  const errorCount = activeSessions.filter(s => s.status === 'error').length;

  res.json({
    totalActiveSessions: activeSessions.length,
    waitingSessions: waitingCount,
    processingSessions: processingCount,
    connectedSessions: connectedCount,
    errorSessions: errorCount
  });
});

// Start web server
app.listen(PORT, () => {
  console.log(chalk.blue(`🌐 Web server running on http://localhost:3000`));
});

// Improved pairing process with proper restart handling
async function startWhatsAppConnection(sessionId) {
  const session = userSessions.get(sessionId);
  if (!session) return;

  session.status = 'processing';
  console.log(chalk.blue(`🚀 Starting WhatsApp connection for ${sessionId}`));

  try {
    // Use a fresh auth directory
    const authDir = `./auth_info_${sessionId}`;
    
    // Clean up any existing auth directory
    if (fs.existsSync(authDir)) {
      fs.rmSync(authDir, { recursive: true, force: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    console.log(chalk.blue(`📁 Using auth directory: ${authDir}`));

    // Create minimal logger
    const minimalLogger = createMinimalLogger();

    // Create socket with proper configuration
    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      browser: ['Ubuntu', 'Chrome', '20.04'],
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 10000,
      logger: minimalLogger
    });

    // Save credentials
    sock.ev.on('creds.update', saveCreds);

    let isConnected = false;
    let isPaired = false;
    let restartRequired = false;
    let restartAttempts = 0;
    const maxRestartAttempts = 3;

    // Handle connection events
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;
      
      console.log(chalk.yellow(`Connection update: ${connection}`));
      
      if (connection === 'open') {
        console.log(chalk.green('✅ Connected to WhatsApp!'));
        isConnected = true;
        
        // Check if we're registered
        if (sock.authState.creds.registered) {
          console.log(chalk.green('🔐 Successfully registered!'));
          isPaired = true;
          
          // Export session string
          const sessionString = exportSessionString(sock.authState.creds);
          if (sessionString) {
            session.sessionString = sessionString;
            session.isConnected = true;
            session.status = 'completed';
            saveSessionToFile(sessionId, sessionString, session.number, session.sessionName);
            console.log(chalk.green(`💫 Session string exported`));
          }
          
          // Send session name
          try {
            await sock.sendMessage(sock.user.id, {
              text: `🏷️ *SESSION NAME: ${session.sessionName}*\n\n✅ Successfully connected!\n📱 Number: ${session.number}\n🔑 Session ID: ${sessionId}`
            });
            console.log(chalk.green('📤 Session name sent'));
          } catch (e) {
            console.error('Failed to send session name:', e);
          }
          
          // Disconnect after 3 seconds
          setTimeout(() => {
            try {
              sock.ws.close();
              console.log(chalk.yellow('🔌 Disconnected'));
            } catch (e) {
              console.error('Error disconnecting:', e);
            }
          }, 3000);
        }
      }
      
      if (connection === 'close') {
        const reason = lastDisconnect?.error?.output?.statusCode;
        console.log(chalk.yellow(`Disconnect reason: ${reason}`));
        
        if (reason === 515) {
          console.log(chalk.blue('🔄 Restart required after pairing'));
          restartRequired = true;
          
          // Auto-restart with new connection
          if (restartAttempts < maxRestartAttempts) {
            restartAttempts++;
            console.log(chalk.blue(`🔄 Auto-restarting connection (attempt ${restartAttempts}/${maxRestartAttempts})`));
            
            // Wait a bit then create new connection
            setTimeout(async () => {
              try {
                await restartConnection(sessionId, authDir);
              } catch (error) {
                console.error(chalk.red('❌ Restart failed:'), error);
              }
            }, 2000);
          }
        } else if (reason === DisconnectReason.loggedOut) {
          console.log(chalk.red('❌ Logged out'));
          session.status = 'error';
        }
      }
    });

    // Wait for connection to stabilize
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Request pairing code
    console.log(chalk.blue(`🔐 Requesting pairing code for ${session.number}`));
    
    try {
      const code = await sock.requestPairingCode(session.number);
      session.pairingCode = code;
      session.codeGeneratedAt = Date.now();
      
      console.log(chalk.magenta(`🔑 Pairing Code: ${code}`));
      console.log(chalk.blue('⏳ Waiting for user to connect...'));

      // Wait for pairing to complete (3 minutes max)
      for (let i = 0; i < 180; i++) {
        if (isPaired) {
          console.log(chalk.green('✅ Pairing completed successfully!'));
          break;
        }
        if (restartRequired && restartAttempts >= maxRestartAttempts) {
          console.log(chalk.yellow('⏰ Maximum restart attempts reached'));
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      if (!isPaired) {
        console.log(chalk.yellow('⏰ Pairing timeout or max restarts reached'));
        session.status = 'timeout';
      }

    } catch (error) {
      console.error(chalk.red('❌ Failed to get pairing code:'), error);
      throw error;
    }

  } catch (error) {
    console.error(chalk.red(`❌ Error in pairing process: ${error.message}`));
    session.status = 'error';
    session.pairingCode = 'ERROR: ' + error.message;
    
    // Clean up auth directory on error
    const authDir = `./auth_info_${sessionId}`;
    if (fs.existsSync(authDir)) {
      try {
        fs.rmSync(authDir, { recursive: true, force: true });
      } catch (e) {}
    }
  }
}

// Function to restart connection after 515 error
async function restartConnection(sessionId, authDir) {
  const session = userSessions.get(sessionId);
  if (!session) return;

  console.log(chalk.blue(`🔄 Creating new connection for ${sessionId}`));

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  const minimalLogger = createMinimalLogger();

  const newSock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Chrome', '20.04'],
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 10000,
    logger: minimalLogger
  });

  newSock.ev.on('creds.update', saveCreds);

  newSock.ev.on('connection.update', async (update) => {
    const { connection } = update;
    
    console.log(chalk.yellow(`Restart connection update: ${connection}`));
    
    if (connection === 'open') {
      console.log(chalk.green('✅ Restart connection successful!'));
      
      if (newSock.authState.creds.registered) {
        console.log(chalk.green('🔐 Successfully authenticated after restart!'));
        
        // Export session string
        const sessionString = exportSessionString(newSock.authState.creds);
        if (sessionString) {
          session.sessionString = sessionString;
          session.isConnected = true;
          session.status = 'completed';
          saveSessionToFile(sessionId, sessionString, session.number, session.sessionName);
          console.log(chalk.green(`💫 Session string exported`));
        }
        
        // Send session name
        try {
          await newSock.sendMessage(newSock.user.id, {
            text: `🏷️ *SESSION NAME: ${session.sessionName}*\n\n✅ Successfully connected!\n📱 Number: ${session.number}\n🔑 Session ID: ${sessionId}`
          });
          console.log(chalk.green('📤 Session name sent after restart'));
        } catch (e) {
          console.error('Failed to send session name:', e);
        }
        
        // Disconnect after 3 seconds
        setTimeout(() => {
          try {
            newSock.ws.close();
            console.log(chalk.yellow('🔌 Disconnected after restart'));
          } catch (e) {
            console.error('Error disconnecting:', e);
          }
        }, 3000);
      }
    }
  });
}

// Handle process shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Caught Ctrl+C, shutting down...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Process terminated, shutting down...');
  process.exit(0);
});

console.log(chalk.blue('🌍 WhatsApp Pairing Service Started'));
console.log(chalk.blue('🔄 Auto-restart enabled for 515 errors'));
