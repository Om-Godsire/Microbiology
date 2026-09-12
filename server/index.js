const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const connectDB = require('./db');
const analysesRouter = require('./routes/analyses');

const app = express();
const httpServer = http.createServer(app);

/* ─── Socket.io ─── */
const io = new Server(httpServer, {
  cors: {
    origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
    methods: ['GET', 'POST'],
  },
});

app.set('io', io);

io.on('connection', socket => {
  console.log(`[WS] Client connected: ${socket.id}`);
  socket.on('disconnect', () => console.log(`[WS] Client disconnected: ${socket.id}`));
});

/* ─── Middleware ─── */
app.use(cors({ origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173' }));
app.use(express.json({ limit: '20mb' }));   // images can be large

/* ─── Routes ─── */
app.use('/api/analyses', analysesRouter);

app.get('/api/health', (req, res) =>
  res.json({ ok: true, time: new Date().toISOString(), version: '1.0.0' })
);

/* ─── Start ─── */
const PORT = parseInt(process.env.PORT) || 3001;

async function start() {
  try {
    await connectDB();
    httpServer.listen(PORT, () => {
      console.log(`[SERVER] MicroScan backend running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('[SERVER] Startup failed:', err.message);
    process.exit(1);
  }
}

start();
