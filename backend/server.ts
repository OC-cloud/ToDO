import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import mongoose from "mongoose";
import { randomUUID } from "crypto";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import cors, { type CorsOptions } from "cors";
const PORT = Number(process.env.PORT) || 5000;
const MONGODB_URI = process.env.MONGODB_URI;
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRE = process.env.JWT_EXPIRE || "30d";
const CLIENT_URL = process.env.CLIENT_URL;
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || "";
const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
const ALLOWED_THEMES = ["classic", "ocean", "sunset", "forest"] as const;
type ThemeName = (typeof ALLOWED_THEMES)[number];
const generateTaskflowId = () => `tf_${randomUUID()}`;
const required = ["MONGODB_URI", "JWT_SECRET", "CLIENT_URL"] as const;

required.forEach((key) => {
  if (!process.env[key]) {
    console.error(`FATAL: Missing environment variable: ${key}`);
    process.exit(1);
  }
});

const allowedOrigins = [
  CLIENT_URL!,
  ...ALLOWED_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean),
];

const validateOrigin = (origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) => {
  if (!origin) return callback(null, true);
  if (allowedOrigins.includes(origin) || origin.endsWith(".vercel.app")) {
    return callback(null, true);
  }
  return callback(new Error(`CORS blocked: ${origin}`));
};

const corsOptions: CorsOptions = {
  origin: validateOrigin,
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

const app = express();
app.use(cors(corsOptions));
app.options("/:path*", cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/", (_req, res) => res.json({ status: "API running" }));

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: validateOrigin,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  },
});

let useSQLite = false;
const db: any = null;

mongoose.connect(MONGODB_URI!)
  .then(() => console.log("MongoDB connected"))
  .catch((err) => {
    console.error("MongoDB connection failed:", err.message);
    process.exit(1);
  });

// Models / DB Wrappers
const UserSchema = new mongoose.Schema({
  taskflowId: { type: String, unique: true, required: true, default: generateTaskflowId },
  username: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  onlineStatus: { type: Boolean, default: false },
  theme: { type: String, enum: ALLOWED_THEMES, default: "classic" },
  createdAt: { type: Date, default: Date.now },
});

const TaskSchema = new mongoose.Schema({
  title: { type: String, required: true },
  description: { type: String },
  dueDate: { type: Date },
  completed: { type: Boolean, default: false },
  completedAt: { type: Date, default: null },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  createdByUsername: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

const CommentSchema = new mongoose.Schema({
  taskId: { type: mongoose.Schema.Types.ObjectId, ref: 'Task', required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  username: { type: String, required: true },
  commentText: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

const MessageSchema = new mongoose.Schema({
  senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  senderName: { type: String, required: true },
  message: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
});

const User = mongoose.model("User", UserSchema);
const Task = mongoose.model("Task", TaskSchema);
const Comment = mongoose.model("Comment", CommentSchema);
const Message = mongoose.model("Message", MessageSchema);

const cleanupExpiredTasks = async () => {
  const cutoffDate = new Date(Date.now() - TWO_DAYS_MS);

  if (useSQLite && db) {
    const cutoffIso = cutoffDate.toISOString();
    db.prepare(`
      DELETE FROM tasks
      WHERE completed = 1
        AND datetime(COALESCE(completedAt, createdAt)) <= datetime(?)
    `).run(cutoffIso);
    db.prepare(`
      DELETE FROM tasks
      WHERE completed = 0
        AND dueDate IS NOT NULL
        AND dueDate != ''
        AND datetime(dueDate) <= datetime(?)
    `).run(cutoffIso);
    db.prepare("DELETE FROM comments WHERE taskId NOT IN (SELECT id FROM tasks)").run();
    return;
  }

  await Task.deleteMany({
    completed: true,
    $or: [
      { completedAt: { $lte: cutoffDate } },
      { completedAt: null, createdAt: { $lte: cutoffDate } },
    ],
  });

  await Task.deleteMany({
    completed: false,
    dueDate: { $ne: null, $lte: cutoffDate },
  });

  await Comment.deleteMany({
    taskId: { $nin: (await Task.find({}, "_id").lean()).map((task: any) => task._id) },
  });
};

const normalizeDueDate = (dueDate: any) => {
  if (!dueDate || typeof dueDate !== "string") return null;
  const trimmedDueDate = dueDate.trim();
  if (!trimmedDueDate) return null;

  const normalizedInput = trimmedDueDate.includes("T")
    ? trimmedDueDate
    : `${trimmedDueDate}T23:59:59`;
  const parsedDate = new Date(normalizedInput);
  if (Number.isNaN(parsedDate.getTime())) return null;
  return parsedDate.toISOString();
};

// Auth Middleware
const authenticateToken = (req: any, res: any, next: any) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.sendStatus(401);

  jwt.verify(token, JWT_SECRET!, (err: any, user: any) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
};

// Auth Routes
app.post("/api/auth/register", async (req, res) => {
  try {
    const { username, email, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    
    if (useSQLite && db) {
      const id = Math.random().toString(36).substr(2, 9);
      db.prepare("INSERT INTO users (id, username, email, password) VALUES (?, ?, ?, ?)").run(id, username, email, hashedPassword);
    } else {
      const user = new User({ username, email, password: hashedPassword, theme: "classic" });
      await user.save();
    }
    res.status(201).json({ message: "User registered successfully" });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    let user: any;

    if (useSQLite && db) {
      user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    } else {
      user = await User.findOne({ email });
    }

    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    
    const userId = useSQLite ? user.id : user._id;
    const token = jwt.sign({ userId, username: user.username }, JWT_SECRET!, { expiresIn: JWT_EXPIRE as any });
    res.json({
      token,
      user: {
        id: userId,
        username: user.username,
        email: user.email,
        theme: (user.theme || "classic") as ThemeName,
      },
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// User Routes
app.get("/api/users", authenticateToken, async (req, res) => {
  try {
    if (useSQLite && db) {
      const users = db.prepare("SELECT id, username, onlineStatus, 'classic' as theme FROM users").all();
      res.json(users.map((u: any) => ({ ...u, _id: u.id, onlineStatus: !!u.onlineStatus })));
    } else {
      const users = await User.find({}, 'username onlineStatus theme');
      res.json(users);
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.patch("/api/users/me/theme", authenticateToken, async (req: any, res) => {
  try {
    const { theme } = req.body || {};
    if (!ALLOWED_THEMES.includes(theme)) {
      return res.status(400).json({ error: "Invalid theme value" });
    }

    if (useSQLite && db) {
      return res.status(400).json({ error: "MongoDB is required for theme persistence" });
    }

    const updatedUser = await User.findByIdAndUpdate(
      req.user.userId,
      { theme },
      { new: true }
    );
    if (!updatedUser) return res.status(404).json({ error: "User not found" });

    res.json({
      id: updatedUser._id,
      username: updatedUser.username,
      email: updatedUser.email,
      theme: updatedUser.theme || "classic",
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/users/me", authenticateToken, async (req: any, res) => {
  try {
    if (useSQLite && db) {
      return res.status(400).json({ error: "MongoDB is required for account deletion" });
    }

    const userId = req.user.userId;
    const existingUser = await User.findById(userId);
    if (!existingUser) return res.status(404).json({ error: "User not found" });

    const ownedTasks = await Task.find({ createdBy: userId }, "_id").lean();
    const ownedTaskIds = ownedTasks.map((task: any) => task._id);

    const commentDeleteQuery: any = { $or: [{ userId }] };
    if (ownedTaskIds.length > 0) {
      commentDeleteQuery.$or.push({ taskId: { $in: ownedTaskIds } });
    }

    await Promise.all([
      Comment.deleteMany(commentDeleteQuery),
      Message.deleteMany({ senderId: userId }),
      Task.deleteMany({ createdBy: userId }),
      User.findByIdAndDelete(userId),
    ]);

    for (const [socketId, mappedUserId] of socketToUser.entries()) {
      if (mappedUserId === String(userId)) {
        socketToUser.delete(socketId);
      }
    }
    io.emit("user_status_change", { userId: String(userId), onlineStatus: false });

    res.json({ message: "Account deleted successfully" });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Task Routes
app.get("/api/tasks", authenticateToken, async (req: any, res) => {
  try {
    await cleanupExpiredTasks();

    if (useSQLite && db) {
      const tasks = db.prepare("SELECT * FROM tasks ORDER BY createdAt DESC").all();
      res.json(tasks.map((t: any) => ({ ...t, _id: t.id, completed: !!t.completed })));
    } else {
      const tasks = await Task.find().sort({ createdAt: -1 });
      res.json(tasks);
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/tasks", authenticateToken, async (req: any, res) => {
  try {
    const { title, description, dueDate } = req.body;
    const normalizedDueDate = normalizeDueDate(dueDate);
    if (useSQLite && db) {
      const id = Math.random().toString(36).substr(2, 9);
      db.prepare("INSERT INTO tasks (id, title, description, dueDate, createdBy, createdByUsername) VALUES (?, ?, ?, ?, ?, ?)").run(id, title, description, normalizedDueDate, req.user.userId, req.user.username);
      const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
      res.status(201).json({ ...task, _id: task.id, completed: !!task.completed });
    } else {
      const task = new Task({
        title,
        description,
        dueDate: normalizedDueDate,
        createdBy: req.user.userId,
        createdByUsername: req.user.username
      });
      await task.save();
      res.status(201).json(task);
    }
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.put("/api/tasks/:id", authenticateToken, async (req: any, res) => {
  try {
    if (useSQLite && db) {
      const { title, description, dueDate, completed } = req.body;
      const normalizedDueDate = normalizeDueDate(dueDate);
      const completedAt = completed ? new Date().toISOString() : null;
      const result = db.prepare("UPDATE tasks SET title = ?, description = ?, dueDate = ?, completed = ?, completedAt = ? WHERE id = ? AND createdBy = ?")
        .run(title, description, normalizedDueDate, completed ? 1 : 0, completedAt, req.params.id, req.user.userId);
      if (result.changes === 0) return res.status(403).json({ error: "Unauthorized or task not found" });
      const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id);
      res.json({ ...task, _id: task.id, completed: !!task.completed });
    } else {
      const updatePayload: any = { ...req.body };
      if (Object.prototype.hasOwnProperty.call(req.body, "dueDate")) {
        updatePayload.dueDate = normalizeDueDate(req.body.dueDate);
      }
      if (Object.prototype.hasOwnProperty.call(req.body, "completed")) {
        updatePayload.completedAt = req.body.completed ? new Date() : null;
      }
      const task = await Task.findOneAndUpdate(
        { _id: req.params.id, createdBy: req.user.userId },
        updatePayload,
        { new: true }
      );
      if (!task) return res.status(403).json({ error: "Unauthorized or task not found" });
      res.json(task);
    }
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

app.delete("/api/tasks/:id", authenticateToken, async (req: any, res) => {
  try {
    if (useSQLite && db) {
      const result = db.prepare("DELETE FROM tasks WHERE id = ? AND createdBy = ?").run(req.params.id, req.user.userId);
      if (result.changes === 0) return res.status(403).json({ error: "Unauthorized or task not found" });
    } else {
      const task = await Task.findOneAndDelete({ _id: req.params.id, createdBy: req.user.userId });
      if (!task) return res.status(403).json({ error: "Unauthorized or task not found" });
    }
    res.json({ message: "Task deleted" });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.patch("/api/tasks/:id/complete", authenticateToken, async (req: any, res) => {
  try {
    if (useSQLite && db) {
      const task = db.prepare("SELECT * FROM tasks WHERE id = ? AND createdBy = ?").get(req.params.id, req.user.userId);
      if (!task) return res.status(403).json({ error: "Unauthorized or task not found" });
      const newStatus = task.completed ? 0 : 1;
      const completedAt = newStatus ? new Date().toISOString() : null;
      db.prepare("UPDATE tasks SET completed = ?, completedAt = ? WHERE id = ?").run(newStatus, completedAt, req.params.id);
      const updatedTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id);
      res.json({ ...updatedTask, _id: updatedTask.id, completed: !!updatedTask.completed });
    } else {
      const task = await Task.findOne({ _id: req.params.id, createdBy: req.user.userId });
      if (!task) return res.status(403).json({ error: "Unauthorized or task not found" });
      task.completed = !task.completed;
      task.completedAt = task.completed ? new Date() : null;
      await task.save();
      res.json(task);
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Comment Routes
app.get("/api/tasks/:id/comments", authenticateToken, async (req, res) => {
  try {
    if (useSQLite && db) {
      const comments = db.prepare("SELECT * FROM comments WHERE taskId = ? ORDER BY createdAt ASC").all(req.params.id);
      res.json(comments.map((c: any) => ({ ...c, _id: c.id })));
    } else {
      const comments = await Comment.find({ taskId: req.params.id }).sort({ createdAt: 1 });
      res.json(comments);
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/tasks/:id/comments", authenticateToken, async (req: any, res) => {
  try {
    const { commentText } = req.body;
    if (useSQLite && db) {
      const id = Math.random().toString(36).substr(2, 9);
      db.prepare("INSERT INTO comments (id, taskId, userId, username, commentText) VALUES (?, ?, ?, ?, ?)").run(id, req.params.id, req.user.userId, req.user.username, commentText);
      const comment = db.prepare("SELECT * FROM comments WHERE id = ?").get(id);
      res.status(201).json({ ...comment, _id: comment.id });
    } else {
      const comment = new Comment({
        taskId: req.params.id,
        userId: req.user.userId,
        username: req.user.username,
        commentText
      });
      await comment.save();
      res.status(201).json(comment);
    }
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
});

// Chat History
app.get("/api/messages", authenticateToken, async (req, res) => {
  try {
    if (useSQLite && db) {
      const messages = db.prepare("SELECT * FROM messages ORDER BY timestamp ASC LIMIT 50").all();
      res.json(messages.map((m: any) => ({ ...m, _id: m.id })));
    } else {
      const messages = await Message.find().sort({ timestamp: 1 }).limit(50);
      res.json(messages);
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/messages", authenticateToken, async (req: any, res) => {
  try {
    const incomingMessage = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    if (!incomingMessage) {
      return res.status(400).json({ error: "Message is required" });
    }

    const senderId = req.user.userId;
    const senderName = req.user.username;
    const newMessage = new Message({ senderId, senderName, message: incomingMessage });
    await newMessage.save();

    io.emit("receive_message", newMessage);
    res.status(201).json(newMessage);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Socket.io Presence and Chat
const socketToUser = new Map<string, string>();

io.on("connection", (socket) => {
  socket.on("authenticate", async (userId) => {
    socketToUser.set(socket.id, userId);
    
    if (useSQLite && db) {
      db.prepare("UPDATE users SET onlineStatus = 1 WHERE id = ?").run(userId);
    } else {
      await User.findByIdAndUpdate(userId, { onlineStatus: true });
    }
    io.emit("user_status_change", { userId, onlineStatus: true });
  });

  socket.on("send_message", async (data) => {
    try {
      const { senderId, senderName, message } = data;
      let newMessage: any;
      if (useSQLite && db) {
        const id = Math.random().toString(36).substr(2, 9);
        db.prepare("INSERT INTO messages (id, senderId, senderName, message) VALUES (?, ?, ?, ?)").run(id, senderId, senderName, message);
        newMessage = db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
        newMessage = { ...newMessage, _id: newMessage.id };
      } else {
        const msg = new Message({ senderId, senderName, message });
        await msg.save();
        newMessage = msg;
      }
      io.emit("receive_message", newMessage);
    } catch (error) {
      console.error("Error saving message:", error);
    }
  });

  socket.on("disconnect", async () => {
    const userId = socketToUser.get(socket.id);
    if (userId) {
      socketToUser.delete(socket.id);
      
      // Check if user has other sockets open
      const otherSockets = Array.from(socketToUser.values()).includes(userId);
      if (!otherSockets) {
        if (useSQLite && db) {
          db.prepare("UPDATE users SET onlineStatus = 0 WHERE id = ?").run(userId);
        } else {
          await User.findByIdAndUpdate(userId, { onlineStatus: false });
        }
        io.emit("user_status_change", { userId, onlineStatus: false });
      }
    }
  });
});

async function startServer() {
  await cleanupExpiredTasks().catch((error) => {
    console.error("Initial task cleanup failed:", error);
  });

  httpServer.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });

  setInterval(() => {
    cleanupExpiredTasks().catch((error) => {
      console.error("Scheduled task cleanup failed:", error);
    });
  }, 60 * 60 * 1000);
}

if (!process.env.VERCEL) {
  startServer();
} else {
  cleanupExpiredTasks().catch((error) => {
    console.error("Initial task cleanup failed:", error);
  });
}

export default app;
