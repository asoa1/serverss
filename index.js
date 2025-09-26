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
import archiver from 'archiver';
import { spawn, execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Function to check and install dependencies
async function installDependencies() {
  return new Promise((resolve, reject) => {
    console.log(chalk.blue('📦 Checking dependencies...'));
    
    try {
      // Check if node_modules exists
      if (!fs.existsSync(path.join(__dirname, 'node_modules'))) {
        console.log(chalk.yellow('🔧 node_modules not found. Running npm install...'));
        execSync('npm install', { stdio: 'inherit', cwd: __dirname });
        console.log(chalk.green('✅ Dependencies installed successfully!'));
      } else {
        console.log(chalk.green('✅ Dependencies already installed.'));
      }
      resolve();
    } catch (error) {
      console.error(chalk.red('❌ Failed to install dependencies:'), error);
      reject(error);
    }
  });
}

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
    status: 'waiting',
    authDir: `./auth_info_${sessionId}` // Store auth directory path
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

// API endpoint: download zipped auth_info folder
app.get('/api/auth-folder/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const authDir = path.join(process.cwd(), `auth_info_${sessionId}`);

  if (!fs.existsSync(authDir)) {
    return res.status(404).json({ error: 'Auth folder not found' });
  }

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename=auth_info_${sessionId}.zip`);

  const archive = archiver("zip");
  archive.directory(authDir, false);
  archive.pipe(res);
  archive.finalize();
});

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
    authDir: session.authDir,
    age: Date.now() - session.createdAt
  });
});

// API endpoint to get statistics (only counts, no sensitive data)
app.get('/api/stats', (req, res) => {
  const activeSessions = Array.from(userSessions.values()).filter(
    session => Date.now() - session.createdAt < PENDING_EXPIRY
  );

  const waitingCount = activeSessions.filter(s => s.status === 'waiting').length;
  const processingCount = activeSessions.filter(s => s.status === 'processing').length;
  const connectedCount = activeSessions.filter(s => s.isConnected).length;
  const errorCount = activeSessions.filter(s => s.status === 'error').length;

  res.json({
    totalActiveSessions: activeSessions.length,
    waitingSessions: waitingCount,
    processingSessions: processingCount,
    connectedSessions: connectedCount,
    errorSessions: errorCount,
    rateLimitTimeout: '120s'
  });
});

// API endpoint to get session data
app.get('/api/session-data/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  
  // First check memory (active sessions)
  const session = userSessions.get(sessionId);
  if (session && session.sessionString) {
    return res.json({
      sessionId: session.sessionId,
      sessionName: session.sessionName,
      number: session.number,
      sessionString: session.sessionString,
      createdAt: session.createdAt,
      exportedAt: new Date().toISOString()
    });
  }

  // If not in memory, check file system (for completed sessions)
  const sessionFile = path.join(__dirname, 'sessions', `${sessionId}.json`);
  if (fs.existsSync(sessionFile)) {
    try {
      const sessionData = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
      
      // Only return if session has a sessionString (completed session)
      if (sessionData.sessionString) {
        return res.json({
          sessionId: sessionData.sessionId,
          sessionName: sessionData.sessionName,
          number: sessionData.number,
          sessionString: sessionData.sessionString,
          createdAt: sessionData.createdAt,
          exportedAt: sessionData.exportedAt || new Date().toISOString()
        });
      } else {
        return res.status(400).json({ error: 'Session not connected yet' });
      }
    } catch (error) {
      console.error('Error reading session file:', error);
      return res.status(500).json({ error: 'Error reading session file' });
    }
  }

  return res.status(404).json({ error: 'Session not found' });
});

// NEW: API endpoint to list all auth_info directories
app.get('/api/auth-directories', (req, res) => {
  try {
    const currentDir = process.cwd();
    const files = fs.readdirSync(currentDir);
    
    const authDirs = files.filter(file => {
      return file.startsWith('auth_info_') && fs.statSync(file).isDirectory();
    }).map(dir => {
      const sessionId = dir.replace('auth_info_', '');
      const session = userSessions.get(sessionId);
      
      return {
        directory: dir,
        sessionId: sessionId,
        sessionName: session ? session.sessionName : 'Unknown',
        status: session ? session.status : 'unknown',
        exists: true,
        path: path.resolve(currentDir, dir)
      };
    });
    
    res.json({
      currentDirectory: currentDir,
      authDirectories: authDirs,
      total: authDirs.length
    });
  } catch (error) {
    console.error('Error reading auth directories:', error);
    res.status(500).json({ error: 'Error reading directories' });
  }
});

// NEW: API endpoint to view specific auth_info directory contents
app.get('/api/auth-directory/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const authDir = `auth_info_${sessionId}`;
  const authDirPath = path.join(process.cwd(), authDir);
  
  if (!fs.existsSync(authDirPath)) {
    return res.status(404).json({ error: 'Auth directory not found' });
  }
  
  try {
    const files = fs.readdirSync(authDirPath);
    const fileContents = {};
    
    files.forEach(file => {
      const filePath = path.join(authDirPath, file);
      try {
        if (fs.statSync(filePath).isFile()) {
          const content = fs.readFileSync(filePath, 'utf8');
          // For credential files, show first few chars to avoid exposing full keys
          if (file.includes('creds') || file.includes('key')) {
            fileContents[file] = {
              preview: content.substring(0, 100) + '...',
              size: content.length,
              fullContent: content // Be careful with this in production!
            };
          } else {
            fileContents[file] = {
              content: content,
              size: content.length
            };
          }
        }
      } catch (readError) {
        fileContents[file] = { error: 'Could not read file' };
      }
    });
    
    const session = userSessions.get(sessionId);
    
    res.json({
      directory: authDir,
      sessionId: sessionId,
      sessionName: session ? session.sessionName : 'Unknown',
      status: session ? session.status : 'unknown',
      path: authDirPath,
      files: files,
      contents: fileContents,
      totalFiles: files.length
    });
  } catch (error) {
    console.error('Error reading auth directory:', error);
    res.status(500).json({ error: 'Error reading directory contents' });
  }
});

// NEW: API endpoint to view specific file in auth directory
app.get('/api/auth-file/:sessionId/:filename', (req, res) => {
  const { sessionId, filename } = req.params;
  const authDir = `auth_info_${sessionId}`;
  const filePath = path.join(process.cwd(), authDir, filename);
  
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const stats = fs.statSync(filePath);
    
    res.json({
      filename: filename,
      sessionId: sessionId,
      path: filePath,
      size: stats.size,
      modified: stats.mtime,
      content: content
    });
  } catch (error) {
    console.error('Error reading auth file:', error);
    res.status(500).json({ error: 'Error reading file' });
  }
});

// NEW: API endpoint to delete auth directory (cleanup)
app.delete('/api/auth-directory/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const authDir = `auth_info_${sessionId}`;
  const authDirPath = path.join(process.cwd(), authDir);
  
  if (!fs.existsSync(authDirPath)) {
    return res.status(404).json({ error: 'Auth directory not found' });
  }
  
  try {
    fs.rmSync(authDirPath, { recursive: true, force: true });
    res.json({ 
      success: true, 
      message: `Auth directory ${authDir} deleted successfully` 
    });
  } catch (error) {
    console.error('Error deleting auth directory:', error);
    res.status(500).json({ error: 'Error deleting directory' });
  }
});

// Start web server with dependency check
async function startServer() {
  try {
    // Install dependencies first
    await installDependencies();
    
    // Then start the server
    app.listen(PORT, () => {
      console.log(chalk.green(`✅ Dependencies checked and installed!`));
      console.log(chalk.blue(`🌐 Web server running on http://localhost:${PORT}`));
      console.log(chalk.blue(`📁 Auth directories API available at /api/auth-directories`));
    });
  } catch (error) {
    console.error(chalk.red('❌ Failed to start server:'), error);
    process.exit(1);
  }
}

// Start the server
startServer();

// Fixed WhatsApp connection functions
async function startWhatsAppConnection(sessionId) {
  const session = userSessions.get(sessionId);
  if (!session) return;

  session.status = 'processing';
  console.log(chalk.blue(`🚀 Starting WhatsApp connection for ${sessionId}`));

  try {
    // Use a fresh auth directory
    const authDir = `./auth_info_${sessionId}`;
    session.authDir = authDir;
    
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
          
          // Send session name with connection check - MODIFIED SECTION
          try {
            // Wait a bit for connection to stabilize
            await new Promise(resolve => setTimeout(resolve, 1000));

            if (sock.ws && sock.ws.readyState === sock.ws.OPEN) {
              // 1️⃣ FIRST MESSAGE: Send only the session ID
              const firstMessage = await sock.sendMessage(sock.user.id, {
                text: `${sessionId}`
              });
              console.log(chalk.green('📤 Session ID sent'));

              // 2️⃣ SECOND MESSAGE: Send instructions as reply after 1 second delay
              await new Promise(resolve => setTimeout(resolve, 1000));
              
              if (firstMessage && firstMessage.key) {
                // Send as reply to the first message
                await sock.sendMessage(sock.user.id, {
                  text: `────────────────────────────────────────────
❄️🔥 Welcome to 𝗜𝗰𝗲𝘆-𝗠𝗗 🔥❄️
────────────────────────────────────────────

✨ Your Session ID is ready! ✨

👉 SESSION ID: 
${sessionId}

⚙️ Put this Session ID into the configuration file
📥 Download it from: https://iceymd.onrender.com

────────────────────────────────────────────
❄️ Enjoy smooth WhatsApp automation with Icey-MD ❄️
────────────────────────────────────────────
`,
                  contextInfo: {
                    stanzaId: firstMessage.key.id,
                    participant: firstMessage.key.remoteJid,
                    quotedMessage: {
                      conversation: sessionId
                    }
                  }
                });
                console.log(chalk.green('📤 Instruction sent as reply'));
              } else {
                // Fallback: send as normal message if reply fails
                await sock.sendMessage(sock.user.id, {
                  text: `────────────────────────────────────────────
❄️🔥 Welcome to 𝗜𝗰𝗲𝘆-𝗠𝗗 🔥❄️
────────────────────────────────────────────

✨ Your Session ID is ready! ✨

👉 SESSION ID: 
${sessionId}

⚙️ Put this Session ID into the configuration file
📥 Download it from: https://iceymd.onrender.com

────────────────────────────────────────────
❄️ Enjoy smooth WhatsApp automation with Icey-MD ❄️
────────────────────────────────────────────
`
                });
                console.log(chalk.green('📤 Instruction sent as normal message (fallback)'));
              }
            } else {
              console.log(chalk.yellow('⚠️ Connection not open, skipping message send'));
            }
          } catch (e) {
            console.error('Failed to send session name:', e);
          }

          // Disconnect after 4 seconds to allow both messages to be sent
          setTimeout(() => {
            try {
              console.log(chalk.yellow('🔌 Disconnecting...'));
              if (sock.ws) {
                sock.ws.close();
              }
            } catch (e) {
              console.error('Error disconnecting:', e);
            }
          }, 4000);
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
                session.status = 'error';
              }
            }, 2000);
          } else {
            console.log(chalk.red('❌ Max restart attempts reached'));
            session.status = 'error';
          }
        } else if (reason === DisconnectReason.loggedOut) {
          console.log(chalk.red('❌ Logged out'));
          session.status = 'error';
        } else if (reason === DisconnectReason.connectionClosed) {
          console.log(chalk.yellow('🔌 Connection closed normally'));
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
          session.status = 'timeout';
          break;
        }
        if (session.status === 'error') {
          console.log(chalk.red('❌ Session error detected, stopping wait'));
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      if (!isPaired && session.status !== 'error') {
        console.log(chalk.yellow('⏰ Pairing timeout reached'));
        session.status = 'timeout';
      }

    } catch (error) {
      console.error(chalk.red('❌ Failed to get pairing code:'), error);
      session.status = 'error';
      session.pairingCode = 'ERROR: ' + error.message;
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
      } catch (e) {
        console.error('Error cleaning up auth directory:', e);
      }
    }
  }
}

// Fixed restart connection function
async function restartConnection(sessionId, authDir) {
  const session = userSessions.get(sessionId);
  if (!session) return;

  console.log(chalk.blue(`🔄 Creating new connection for ${sessionId}`));

  try {
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
          
          // Send session name with connection check (same 1-second delay with reply)
          try {
            // Wait for connection to stabilize
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            if (newSock.ws && newSock.ws.readyState === newSock.ws.OPEN) {
              // 1️⃣ FIRST MESSAGE: Send only the session ID
              const firstMessage = await newSock.sendMessage(newSock.user.id, {
                text: `${sessionId}`
              });
              console.log(chalk.green('📤 Session ID sent after restart'));

              // 2️⃣ SECOND MESSAGE: Send instructions as reply after 1 second delay
              await new Promise(resolve => setTimeout(resolve, 1000));
              
              if (firstMessage && firstMessage.key) {
                // Send as reply to the first message
                await newSock.sendMessage(newSock.user.id, {
                  text: `────────────────────────────────────────────
❄️🔥 Welcome to 𝗜𝗰𝗲𝘆-𝗠𝗗 🔥❄️
────────────────────────────────────────────

✨ Your Session ID is ready! ✨

👉 SESSION ID: 
${sessionId}

⚙️ Put this Session ID into the configuration file
📥 Download it from: https://iceymd.onrender.com

────────────────────────────────────────────
❄️ Enjoy smooth WhatsApp automation with Icey-MD ❄️
────────────────────────────────────────────
`,
                  contextInfo: {
                    stanzaId: firstMessage.key.id,
                    participant: firstMessage.key.remoteJid,
                    quotedMessage: {
                      conversation: sessionId
                    }
                  }
                });
                console.log(chalk.green('📤 Instruction sent as reply after restart'));
              } else {
                // Fallback: send as normal message if reply fails
                await newSock.sendMessage(newSock.user.id, {
                  text: `────────────────────────────────────────────
❄️🔥 Welcome to 𝗜𝗰𝗲𝘆-𝗠𝗗 🔥❄️
────────────────────────────────────────────

✨ Your Session ID is ready! ✨

👉 SESSION ID: 
${sessionId}

⚙️ Put this Session ID into the configuration file
📥 Download it from: https://iceymd.onrender.com

────────────────────────────────────────────
❄️ Enjoy smooth WhatsApp automation with Icey-MD ❄️
────────────────────────────────────────────
`
                });
                console.log(chalk.green('📤 Instruction sent as normal message after restart (fallback)'));
              }
            } else {
              console.log(chalk.yellow('⚠️ Connection not open, skipping message send'));
            }
          } catch (e) {
            console.error('Failed to send session name after restart:', e);
          }
          
          // Disconnect after 4 seconds
          setTimeout(() => {
            try {
              console.log(chalk.yellow('🔌 Disconnecting after restart...'));
              if (newSock.ws) {
                newSock.ws.close();
              }
            } catch (e) {
              console.error('Error disconnecting after restart:', e);
            }
          }, 4000);
        }
      }
      
      if (connection === 'close') {
        console.log(chalk.yellow('🔌 Restart connection closed'));
      }
    });

  } catch (error) {
    console.error(chalk.red('❌ Error in restart connection:'), error);
    session.status = 'error';
  }
}

// Handle process shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Caught Ctrl+C, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Process terminated, shutting down gracefully...');
  process.exit(0);
});

process.on('uncaughtException', (error) => {
  console.error(chalk.red('❌ Uncaught Exception:'), error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error(chalk.red('❌ Unhandled Rejection at:'), promise, 'reason:', reason);
});

console.log(chalk.blue('🌍 WhatsApp Pairing Service Starting...'));
console.log(chalk.blue('🔄 Auto-restart enabled for 515 errors'));
console.log(chalk.blue('🔧 Connection error handling improved'));
