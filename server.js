
const express = require('express');
const fileUpload = require('express-fileupload');
const path = require('path');
const fs = require('fs');
const unzipper = require('unzipper');
const { exec } = require('child_process');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));
app.use(fileUpload());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const BOTS_DIR = path.join(__dirname, 'bots');
if (!fs.existsSync(BOTS_DIR)) fs.mkdirSync(BOTS_DIR);

let currentBotProcess = null;

app.post('/upload', async (req, res) => {
    if (!req.files || !req.files.zipFile) {
        return res.status(400).send('No file uploaded.');
    }

    const zipFile = req.files.zipFile;
    const botName = zipFile.name.replace(/\..+$/, '');
    const extractPath = path.join(BOTS_DIR, botName);

    try {
        if (fs.existsSync(extractPath)) fs.rmSync(extractPath, { recursive: true });
        fs.mkdirSync(extractPath);

        const zipPath = path.join(BOTS_DIR, zipFile.name);
        await zipFile.mv(zipPath);

        fs.createReadStream(zipPath)
          .pipe(unzipper.Extract({ path: extractPath }))
          .on('close', () => {
              fs.unlinkSync(zipPath);

              if (fs.existsSync(path.join(extractPath, 'package.json'))) {
                  exec('npm install', { cwd: extractPath }, (installErr, stdout, stderr) => {
                      if (installErr) {
                          console.error('NPM Install Error:', stderr);
                          return res.status(500).send('npm install failed. Check logs.');
                      }
                      runBot(extractPath, res);
                  });
              } else {
                  runBot(extractPath, res);
              }
          });
    } catch (err) {
        console.error('Upload/Extract Error:', err);
        return res.status(500).send('Error uploading or extracting file.');
    }
});

function runBot(botDir, res) {
    const files = fs.readdirSync(botDir);
    const entryFile = files.find(file => file.endsWith('.js'));

    if (!entryFile) return res.status(400).send('No .js entry file found in ZIP.');

    if (currentBotProcess) {
        currentBotProcess.kill();
        console.log('Previous bot process killed.');
    }

    currentBotProcess = exec(`node ${entryFile}`, { cwd: botDir });

    currentBotProcess.stdout.on('data', data => console.log(`[BOT LOG]: ${data}`));
    currentBotProcess.stderr.on('data', data => console.error(`[BOT ERROR]: ${data}`));
    currentBotProcess.on('exit', code => console.log(`Bot exited with code ${code}`));

    return res.send(`Bot started from ${entryFile}`);
}

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
