const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");

const app = express();
app.use(express.json());
app.use(cors());

// MongoDB Connection
const MONGO_URI = process.env.MONGO_URI || "your_mongodb_connection_string";
mongoose
  .connect(MONGO_URI)
  .then(() => console.log("MongoDB Connected Successfully"))
  .catch((err) => console.error("MongoDB Connection Error:", err));

// User Schema & Model
const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  balance: { type: Number, default: 0 }
});

const User = mongoose.model("User", userSchema);

// Health Check Route (Cron-job ke liye)
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", message: "Server is awake" });
});

// Root Route
app.get("/", (req, res) => {
  res.send("Chat Bro Backend is Running!");
});

// Main Login Logic Function
const handleLogin = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: "Email and password are required!" });
    }

    let user = await User.findOne({ email });

    if (!user) {
      // Agar user pehli baar aa raha hai toh naya account bana lo
      user = new User({ email, password, balance: 0 });
      await user.save();
    } else if (user.password !== password) {
      return res.status(400).json({ success: false, message: "Invalid password!" });
    }

    res.json({
      success: true,
      message: "Login successful!",
      user: {
        email: user.email,
        balance: user.balance || 0
      }
    });
  } catch (error) {
    console.error("Login Error:", error);
    res.status(500).json({ success: false, message: "Server error during login" });
  }
};

// Endpoints (Dono routes support kiye hain taaki kabhie error na aaye)
app.post("/login", handleLogin);
app.post("/api/login", handleLogin);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
