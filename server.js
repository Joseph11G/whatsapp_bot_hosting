const express = require('express');
const fileUpload = require('express-fileupload');
const path = require('path');
const fs = require('fs');
const unzipper = require('unzipper');
const { exec } = require('child_process');
const http = require('http');
const { Server } = require('socket.io');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

// Middleware setup
app.use(express.static('public'));
app.use(fileUpload());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Constants
const BOTS_DIR = path.join(__dirname, 'bots');
if (!fs.existsSync(BOTS_DIR)) fs.mkdirSync(BOTS_DIR);

// Store active processes and logs
const activeProcesses = new Map();

// WebSocket connection
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Helper function to emit logs
function emitLog(botId, message, isError = false) {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] ${isError ? '[ERROR] ' : ''}${message}`;
  io.emit('log', { botId, log: logEntry });
}

app.post('/upload', async (req, res) => {
  if (!req.files?.zipFile) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const zipFile = req.files.zipFile;
  const botId = Date.now().toString();
  const extractPath = path.join(BOTS_DIR, botId);

  try {
    // Cleanup existing directory
    if (fs.existsSync(extractPath)) fs.rmSync(extractPath, { recursive: true });
    fs.mkdirSync(extractPath);

    // Move and extract ZIP
    const zipPath = path.join(BOTS_DIR, zipFile.name);
    await zipFile.mv(zipPath);
    
    const extractStream = fs.createReadStream(zipPath)
      .pipe(unzipper.Extract({ path: extractPath }));

    await new Promise((resolve, reject) => {
      extractStream.on('close', resolve);
      extractStream.on('error', reject);
    });

    fs.unlinkSync(zipPath);
    emitLog(botId, 'ZIP file extracted successfully');

    // Install dependencies if package.json exists
    if (fs.existsSync(path.join(extractPath, 'package.json'))) {
      emitLog(botId, 'Installing dependencies...');
      
      await new Promise((resolve, reject) => {
        const installProcess = exec('npm install', { cwd: extractPath });
        
        installProcess.stdout.on('data', data => 
          emitLog(botId, `[INSTALL] ${data.toString().trim()}`));
        
        installProcess.stderr.on('data', data => 
          emitLog(botId, `[INSTALL ERROR] ${data.toString().trim()}`, true));
        
        installProcess.on('exit', (code) => {
          if (code === 0) {
            emitLog(botId, 'Dependencies installed successfully');
            resolve();
          } else {
            reject(new Error(`npm install failed with code ${code}`));
          }
        });
      });
    }

    // Find entry file
    const files = fs.readdirSync(extractPath);
    const entryFile = files.find(f => f.endsWith('.js'));
    if (!entryFile) throw new Error('No JavaScript entry file found');

    // Kill previous bot if running
    if (activeProcesses.has(botId)) {
      activeProcesses.get(botId).kill();
      emitLog(botId, 'Previous bot instance stopped');
    }

    // Start new bot process
    const botProcess = exec(`node ${entryFile}`, { cwd: extractPath });
    activeProcesses.set(botId, botProcess);

    botProcess.stdout.on('data', data => 
      emitLog(botId, `[BOT] ${data.toString().trim()}`));
    
    botProcess.stderr.on('data', data => 
      emitLog(botId, `[BOT ERROR] ${data.toString().trim()}`, true));
    
    botProcess.on('exit', code => 
      emitLog(botId, `Process exited with code ${code}`, code !== 0));

    res.json({ 
      success: true,
      message: 'Bot started successfully',
      botId,
      entryFile
    });

  } catch (err) {
    emitLog(botId, `[FATAL ERROR] ${err.message}`, true);
    res.status(500).json({ 
      error: 'Bot failed to start',
      details: err.message
    });
    
    // Cleanup failed installation
    if (fs.existsSync(extractPath)) {
      fs.rmSync(extractPath, { recursive: true });
    }
  }
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
