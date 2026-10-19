const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");

const app = express();
app.use(express.json());
app.use(cors());

// Global System Settings for Ad Safety
let globalSettings = {
  dailyAdLimit: 20,       // Max ads per day per user
  cooldownSeconds: 20    // Seconds gap between ads
};

// MongoDB Connection
const MONGO_URI = process.env.MONGO_URI || "your_mongodb_connection_string";
mongoose.connect(MONGO_URI, {
  serverSelectionTimeoutMS: 30000,
  socketTimeoutMS: 45000,
})
.then(() => console.log("MongoDB Connected Successfully!"))
.catch((err) => console.error("MongoDB Connection Error:", err));

// Schemas & Models
const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  balance: { type: Number, default: 0 },
  adsWatched: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  todayAdsCount: { type: Number, default: 0 },
  lastAdDate: { type: String, default: "" },
  lastAdTime: { type: Number, default: 0 }
});

const withdrawalSchema = new mongoose.Schema({
  userEmail: { type: String, required: true },
  upiId: { type: String, required: true },
  amount: { type: Number, required: true },
  status: { type: String, enum: ['Pending', 'Approved', 'Rejected'], default: 'Pending' },
  requestedAt: { type: Date, default: Date.now }
});

const User = mongoose.model("User", userSchema);
const Withdrawal = mongoose.model("Withdrawal", withdrawalSchema);

// --- USER ROUTES ---

// Login Route
app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: "Email and password required!" });
    }

    let user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ success: false, message: "Invalid email or password!" });
    }

    if (user.password !== password) {
      return res.status(401).json({ success: false, message: "Invalid email or password!" });
    }

    res.json({
      success: true,
      message: "Login successful!",
      balance: user.balance,
      adsWatched: user.adsWatched
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error during login" });
  }
});

// Track Ad Impression Route (With Limit & Cooldown Protection)
app.post("/api/track-ad", async (req, res) => {
  try {
    const { email, rewardAmount = 0.002 } = req.body;
    const today = new Date().toISOString().split('T')[0];

    let user = await User.findOne({ email });
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    // New day reset
    if (user.lastAdDate !== today) {
      user.todayAdsCount = 0;
      user.lastAdDate = today;
    }

    // Daily Limit Check
    if (user.todayAdsCount >= globalSettings.dailyAdLimit) {
      return res.status(400).json({ success: false, message: "Daily limit reached!" });
    }

    // Cooldown Timer Check
    const now = Date.now();
    if (user.lastAdTime && (now - user.lastAdTime) < globalSettings.cooldownSeconds * 1000) {
      return res.status(429).json({ success: false, message: "Please wait before watching next ad." });
    }

    user.todayAdsCount += 1;
    user.lastAdTime = now;
    user.balance += Number(rewardAmount);
    user.adsWatched += 1;
    await user.save();

    res.json({ success: true, balance: user.balance, adsWatched: user.adsWatched, todayAdsCount: user.todayAdsCount });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error tracking ad" });
  }
});

// Withdrawal Request Route
app.post("/api/withdraw", async (req, res) => {
  try {
    const { email, upiId, amount } = req.body;
    if (!email || !upiId || !amount) {
      return res.status(400).json({ success: false, message: "All fields are required" });
    }

    const user = await User.findOne({ email });
    if (!user || user.balance < amount) {
      return res.status(400).json({ success: false, message: "Insufficient balance!" });
    }

    user.balance -= amount;
    await user.save();

    const withdrawal = new Withdrawal({ userEmail: email, upiId, amount });
    await withdrawal.save();

    res.json({ success: true, message: "Withdrawal request submitted!", newBalance: user.balance });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error processing withdrawal" });
  }
});

// --- ADMIN DASHBOARD ROUTES ---

// Admin Settings Update Route
app.post('/api/admin/settings', (req, res) => {
  const { dailyAdLimit, cooldownSeconds } = req.body;
  if (dailyAdLimit !== undefined) globalSettings.dailyAdLimit = Number(dailyAdLimit);
  if (cooldownSeconds !== undefined) globalSettings.cooldownSeconds = Number(cooldownSeconds);
  res.json({ message: "Settings updated successfully!", settings: globalSettings });
});

// Secret Passcode for Admin Panel access
const ADMIN_KEY = "AdminSecret123";

// Admin Stats & Data Endpoint
app.get("/api/admin/data", async (req, res) => {
  const { key } = req.query;
  if (key !== ADMIN_KEY) return res.status(403).json({ success: false, message: "Unauthorized!" });

  try {
    const users = await User.find().sort({ createdAt: -1 });
    const withdrawals = await Withdrawal.find().sort({ requestedAt: -1 });

    const totalUsers = users.length;
    const totalAdsWatched = users.reduce((acc, u) => acc + (u.adsWatched || 0), 0);
    const pendingPayouts = withdrawals.filter(w => w.status === 'Pending').reduce((acc, w) => acc + w.amount, 0);

    res.json({
      success: true,
      stats: { totalUsers, totalAdsWatched, pendingPayouts },
      users,
      withdrawals,
      settings: globalSettings
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Admin Approve/Reject Withdrawal
app.post("/api/admin/withdrawal-status", async (req, res) => {
  const { key, withdrawalId, status } = req.body;
  if (key !== ADMIN_KEY) return res.status(403).json({ success: false, message: "Unauthorized!" });

  try {
    const withdrawal = await Withdrawal.findById(withdrawalId);
    if (!withdrawal) return res.status(404).json({ success: false, message: "Request not found" });

    if (status === 'Rejected' && withdrawal.status === 'Pending') {
      const user = await User.findOne({ email: withdrawal.userEmail });
      if (user) {
        user.balance += withdrawal.amount;
        await user.save();
      }
    }

    withdrawal.status = status;
    await withdrawal.save();

    res.json({ success: true, message: `Withdrawal ${status} successfully!` });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Admin Dashboard UI Route
app.get("/admin", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Chat Bro - Admin Panel</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: Arial, sans-serif; background: #0f172a; color: #fff; margin: 0; padding: 20px; }
    h1, h2 { color: #38bdf8; }
    .card-container { display: flex; gap: 15px; margin-bottom: 25px; flex-wrap: wrap; }
    .card { background: #1e293b; padding: 15px 20px; border-radius: 10px; border: 1px solid #334155; flex: 1; min-width: 180px; }
    .card h3 { margin: 0; color: #94a3b8; font-size: 14px; }
    .card p { margin: 5px 0 0; font-size: 24px; font-weight: bold; color: #10b981; }
    table { width: 100%; border-collapse: collapse; background: #1e293b; margin-bottom: 30px; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid #334155; font-size: 14px; }
    th { background: #334155; color: #f8fafc; }
    .btn { padding: 6px 12px; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; }
    .btn-approve { background: #10b981; color: white; }
    .btn-reject { background: #ef4444; color: white; margin-left: 5px; }
    .login-box { max-width: 350px; margin: 100px auto; background: #1e293b; padding: 30px; border-radius: 10px; border: 1px solid #334155; }
    input { width: 90%; padding: 10px; margin: 10px 0; border-radius: 5px; border: 1px solid #334155; background: #0f172a; color: white; }
  </style>
</head>
<body>

  <div id="loginSection" class="login-box">
    <h2>Admin Security Key</h2>
    <input type="password" id="adminKeyInput" placeholder="Enter Security Key" /><br>
    <button class="btn btn-approve" style="width:100%; padding: 10px;" onclick="loadDashboard()">Login</button>
  </div>

  <div id="dashboardSection" style="display:none;">
    <h1>👑 Chat Bro Admin Dashboard</h1>
    <div class="card-container">
      <div class="card"><h3>Total Registered Users</h3><p id="totalUsers">0</p></div>
      <div class="card"><h3>Total Ads Viewed</h3><p id="totalAds">0</p></div>
      <div class="card"><h3>Pending Payouts</h3><p id="pendingPayouts">$0.00</p></div>
    </div>

    <!-- Ad Safety Controls Box -->
    <div style="background: #1e293b; padding: 15px 20px; border-radius: 10px; margin: 20px 0; border: 1px solid #334155;">
      <h3 style="color:#38bdf8; margin-top:0;">⚙️ Ad Safety Controls</h3>
      <div style="display:flex; gap:20px; flex-wrap:wrap; align-items:center;">
        <div>
          <label style="font-size:13px; color:#94a3b8;">Daily Ad Limit Per User:</label><br>
          <input type="number" id="dailyLimitInput" value="20" style="padding: 6px; width: 100px; margin-top: 4px;">
        </div>
        <div>
          <label style="font-size:13px; color:#94a3b8;">Cooldown Gap (in Seconds):</label><br>
          <input type="number" id="cooldownInput" value="20" style="padding: 6px; width: 100px; margin-top: 4px;">
        </div>
        <div style="margin-top:15px;">
          <button onclick="saveSettings()" class="btn btn-approve">Save Settings</button>
        </div>
      </div>
    </div>

    <h2>💳 Withdrawal Requests</h2>
    <table>
      <thead>
        <tr>
          <th>User Email</th>
          <th>UPI ID</th>
          <th>Amount ($)</th>
          <th>Status</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody id="withdrawalsTable"></tbody>
    </table>

    <h2>👥 All Users Activity</h2>
    <table>
      <thead>
        <tr>
          <th>Email</th>
          <th>Balance ($)</th>
          <th>Ads Watched</th>
          <th>Joined Date</th>
        </tr>
      </thead>
      <tbody id="usersTable"></tbody>
    </table>
  </div>

  <script>
    let currentKey = '';

    async function loadDashboard() {
      const key = document.getElementById('adminKeyInput').value;
      if (!key) return alert('Enter key!');

      const res = await fetch('/api/admin/data?key=' + encodeURIComponent(key));
      const data = await res.json();

      if (!data.success) {
        alert('Invalid Admin Key!');
        return;
      }

      currentKey = key;
      document.getElementById('loginSection').style.display = 'none';
      document.getElementById('dashboardSection').style.display = 'block';

      // Set Stats
      document.getElementById('totalUsers').innerText = data.stats.totalUsers;
      document.getElementById('totalAds').innerText = data.stats.totalAdsWatched;
      document.getElementById('pendingPayouts').innerText = '$' + data.stats.pendingPayouts.toFixed(2);

      // Set Safety Control Values
      if (data.settings) {
        document.getElementById('dailyLimitInput').value = data.settings.dailyAdLimit || 20;
        document.getElementById('cooldownInput').value = data.settings.cooldownSeconds || 20;
      }

      // Populate Withdrawals Table
      const wTable = document.getElementById('withdrawalsTable');
      wTable.innerHTML = '';
      data.withdrawals.forEach(w => {
        let actionHtml = w.status === 'Pending' ? 
          \`<button class="btn btn-approve" onclick="updateStatus('\${w._id}', 'Approved')">Approve</button>
           <button class="btn btn-reject" onclick="updateStatus('\${w._id}', 'Rejected')">Reject</button>\` : 
          \`<span>\${w.status}</span>\`;

        wTable.innerHTML += \`<tr>
          <td>\${w.userEmail}</td>
          <td>\${w.upiId}</td>
          <td>\$\${w.amount}</td>
          <td><strong>\${w.status}</strong></td>
          <td>\${actionHtml}</td>
        </tr>\`;
      });

      // Populate Users Table
      const uTable = document.getElementById('usersTable');
      uTable.innerHTML = '';
      data.users.forEach(u => {
        uTable.innerHTML += \`<tr>
          <td>\${u.email}</td>
          <td>\$\${(u.balance || 0).toFixed(4)}</td>
          <td>\${u.adsWatched || 0}</td>
          <td>\${new Date(u.createdAt).toLocaleDateString()}</td>
        </tr>\`;
      });
    }

    async function saveSettings() {
      const dailyAdLimit = document.getElementById('dailyLimitInput').value;
      const cooldownSeconds = document.getElementById('cooldownInput').value;

      try {
        const res = await fetch('/api/admin/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dailyAdLimit: Number(dailyAdLimit), cooldownSeconds: Number(cooldownSeconds) })
        });
        const data = await res.json();
        alert(data.message);
      } catch (err) {
        alert("Failed to save settings!");
      }
    }

    async function updateStatus(id, status) {
      if (!confirm('Are you sure you want to mark this as ' + status + '?')) return;
      const res = await fetch('/api/admin/withdrawal-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: currentKey, withdrawalId: id, status })
      });
      const data = await res.json();
      alert(data.message);
      loadDashboard();
    }
  </script>
</body>
</html>
  `);
});

// Health & Root
app.get("/api/health", (req, res) => res.json({ status: "ok" }));
app.get("/", (req, res) => res.send("Chat Bro Backend is Running!"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
