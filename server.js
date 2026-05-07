require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const app = express();
app.use(cors());
app.use(express.json());

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err.message));

// ─── USER MODEL ────────────────────────────────────────
const UserSchema = new mongoose.Schema({
  username: String,
  email: { type: String, unique: true },
  password: String,
  balance: { type: Number, default: 0 },
  bonusBalance: { type: Number, default: 10 },
  depositAddress: { type: String, default: 'PENDING' },
  referralCode: String,
  referredBy: String,
  vipLevel: { type: Number, default: 0 },
  totalDeposited: { type: Number, default: 0 },
  totalWithdrawn: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

// ─── TRANSACTION MODEL ─────────────────────────────────
const TransactionSchema = new mongoose.Schema({
  userId: mongoose.Schema.Types.ObjectId,
  type: String,
  amount: Number,
  fee: { type: Number, default: 0 },
  currency: String,
  status: String,
  txId: String,
  address: String,
  description: String,
  createdAt: { type: Date, default: Date.now }
});

// ─── GAME ROUND MODEL ──────────────────────────────────
const GameRoundSchema = new mongoose.Schema({
  roundId: { type: String, unique: true },
  gameType: { type: String, default: 'wingo30s' },
  duration: { type: Number, default: 30 },
  result: String,
  resultNumber: Number,
  startTime: Date,
  endTime: Date,
  status: { type: String, default: 'open' }
});

// ─── GAME BET MODEL ────────────────────────────────────
const GameBetSchema = new mongoose.Schema({
  userId: mongoose.Schema.Types.ObjectId,
  roundId: String,
  gameType: String,
  color: String,
  number: Number,
  amount: Number,
  payout: { type: Number, default: 0 },
  status: { type: String, default: 'pending' },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', UserSchema);
const Transaction = mongoose.model('Transaction', TransactionSchema);
const GameRound = mongoose.model('GameRound', GameRoundSchema);
const GameBet = mongoose.model('GameBet', GameBetSchema);

// ─── GAME CONFIG ───────────────────────────────────────
const GAME_TYPES = {
  wingo30s: { duration: 30, label: '30 Seconds' },
  wingo3m: { duration: 180, label: '3 Minutes' },
  wingo5m: { duration: 300, label: '5 Minutes' }
};

// Number to color mapping
// 0 = violet+red, 5 = violet+green
// 1,3,7,9 = green, 2,4,6,8 = red
function getColorFromNumber(num) {
  if (num === 0) return 'violet_red';
  if (num === 5) return 'violet_green';
  if ([1, 3, 7, 9].includes(num)) return 'green';
  return 'red';
}

function getMainColor(num) {
  if (num === 0 || num === 5) return 'violet';
  if ([1, 3, 7, 9].includes(num)) return 'green';
  return 'red';
}

// ─── HELPERS ───────────────────────────────────────────
function generateReferralCode() {
  return Math.random().toString(36).substring(2, 10).toUpperCase();
}

function generateFakeAddress() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz123456789';
  let address = 'T';
  for (let i = 0; i < 33; i++) {
    address += chars[Math.floor(Math.random() * chars.length)];
  }
  return address;
}

function authenticateToken(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  jwt.verify(
    token,
    process.env.JWT_SECRET || 'secret123',
    (err, decoded) => {
      if (err) return res.status(403).json({ error: 'Invalid token' });
      req.userId = decoded.userId;
      next();
    }
  );
}

// ─── REGISTER ──────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  try {
    const { username, email, password, referralCode } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'All fields required' });
    }
    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(400).json({ error: 'Email already registered' });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    const newReferralCode = generateReferralCode();
    const depositAddress = generateFakeAddress();

    const user = new User({
      username,
      email,
      password: hashedPassword,
      depositAddress,
      referralCode: newReferralCode,
      referredBy: referralCode || null
    });
    await user.save();

    await Transaction.create({
      userId: user._id,
      type: 'bonus',
      amount: 10,
      currency: 'USDT',
      status: 'completed',
      txId: 'SIGNUP_BONUS',
      description: 'Welcome bonus'
    });

    if (referralCode) {
      const referrer = await User.findOne({ referralCode });
      if (referrer) {
        referrer.bonusBalance += 5;
        await referrer.save();
        await Transaction.create({
          userId: referrer._id,
          type: 'referral_bonus',
          amount: 5,
          currency: 'USDT',
          status: 'completed',
          txId: `REF_${user._id}`,
          description: `Referral bonus from ${username}`
        });
      }
    }

    const token = jwt.sign(
      { userId: user._id },
      process.env.JWT_SECRET || 'secret123',
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      message: 'Account created successfully',
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        balance: user.balance,
        bonusBalance: user.bonusBalance,
        totalBalance: user.balance + user.bonusBalance,
        depositAddress: user.depositAddress,
        vipLevel: user.vipLevel,
        referralCode: user.referralCode
      }
    });
  } catch (err) {
    console.error('Register error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── LOGIN ─────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Wrong password' });

    const token = jwt.sign(
      { userId: user._id },
      process.env.JWT_SECRET || 'secret123',
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        balance: user.balance,
        bonusBalance: user.bonusBalance,
        totalBalance: user.balance + user.bonusBalance,
        depositAddress: user.depositAddress,
        vipLevel: user.vipLevel,
        referralCode: user.referralCode,
        totalDeposited: user.totalDeposited,
        totalWithdrawn: user.totalWithdrawn
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── BALANCE ───────────────────────────────────────────
app.get('/api/balance', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.totalDeposited >= 10000) user.vipLevel = 5;
    else if (user.totalDeposited >= 5000) user.vipLevel = 4;
    else if (user.totalDeposited >= 1000) user.vipLevel = 3;
    else if (user.totalDeposited >= 500) user.vipLevel = 2;
    else if (user.totalDeposited >= 100) user.vipLevel = 1;
    else user.vipLevel = 0;
    await user.save();

    res.json({
      balance: user.balance,
      bonusBalance: user.bonusBalance,
      totalBalance: user.balance + user.bonusBalance,
      depositAddress: user.depositAddress,
      vipLevel: user.vipLevel,
      username: user.username,
      email: user.email,
      referralCode: user.referralCode,
      totalDeposited: user.totalDeposited,
      totalWithdrawn: user.totalWithdrawn
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── LIVE BALANCE ──────────────────────────────────────
app.get('/api/balance/live', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const pendingBets = await GameBet.find({
      userId: req.userId,
      status: 'pending'
    });

    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const recentWins = await GameBet.find({
      userId: req.userId,
      status: 'won',
      createdAt: { $gte: fiveMinutesAgo }
    });

    res.json({
      balance: user.balance,
      bonusBalance: user.bonusBalance,
      totalBalance: user.balance + user.bonusBalance,
      pendingBets: pendingBets.length,
      recentWins: recentWins.map(b => ({
        amount: b.payout,
        color: b.color,
        number: b.number,
        roundId: b.roundId
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── TRANSACTIONS ──────────────────────────────────────
app.get('/api/transactions', authenticateToken, async (req, res) => {
  try {
    const txs = await Transaction.find({ userId: req.userId })
      .sort({ createdAt: -1 });
    res.json({ transactions: txs, total: txs.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── WITHDRAW ──────────────────────────────────────────
app.post('/api/withdraw', authenticateToken, async (req, res) => {
  try {
    const { amount, address } = req.body;
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!address) return res.status(400).json({ error: 'Address required' });
    if (amount < 10) return res.status(400).json({ error: 'Minimum 10 USDT' });
    if (user.balance < amount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    const fee = 0.5;
    const amountAfterFee = amount - fee;
    user.balance -= amount;
    user.totalWithdrawn += amountAfterFee;
    await user.save();

    await Transaction.create({
      userId: user._id,
      type: 'withdrawal',
      amount: amountAfterFee,
      fee,
      currency: 'USDT.TRC20',
      status: 'pending',
      txId: `WD_${Date.now()}`,
      address,
      description: 'Withdrawal request'
    });

    res.json({
      success: true,
      message: 'Withdrawal submitted successfully',
      amountSent: amountAfterFee,
      fee
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── REFERRALS ─────────────────────────────────────────
app.get('/api/referrals', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const referred = await User.find({ referredBy: user.referralCode });
    res.json({
      referralCode: user.referralCode,
      referralLink: `https://bezztrade.base44.app?ref=${user.referralCode}`,
      totalReferred: referred.length,
      activeUsers: referred.filter(u => u.totalDeposited > 0).length,
      totalCommission: referred.length * 5
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ADMIN ROUTES ──────────────────────────────────────
app.get('/api/admin/users', async (req, res) => {
  try {
    const adminKey = req.headers['admin-key'];
    if (adminKey !== process.env.ADMIN_KEY) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    const users = await User.find({})
      .select('-password')
      .sort({ createdAt: -1 });
    res.json({ users, total: users.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/transactions', async (req, res) => {
  try {
    const adminKey = req.headers['admin-key'];
    if (adminKey !== process.env.ADMIN_KEY) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    const txs = await Transaction.find({})
      .sort({ createdAt: -1 })
      .limit(100);
    res.json({ transactions: txs, total: txs.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/update-balance', async (req, res) => {
  try {
    const adminKey = req.headers['admin-key'];
    if (adminKey !== process.env.ADMIN_KEY) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    const { userId, balance, bonusBalance } = req.body;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (balance !== undefined) user.balance = balance;
    if (bonusBalance !== undefined) user.bonusBalance = bonusBalance;
    await user.save();
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GAME: CREATE NEW ROUND ────────────────────────────
async function createNewRound(gameType = 'wingo30s') {
  const config = GAME_TYPES[gameType];
  const roundId = `${gameType.toUpperCase()}_${Date.now()}`;
  const startTime = new Date();
  const endTime = new Date(startTime.getTime() + config.duration * 1000);
  const resultNumber = Math.floor(Math.random() * 10);
  const result = getColorFromNumber(resultNumber);

  const round = new GameRound({
    roundId,
    gameType,
    duration: config.duration,
    result,
    resultNumber,
    startTime,
    endTime,
    status: 'open'
  });

  await round.save();
  console.log(`🎮 New ${gameType} roun  status: String,
  txId: String,
  address: String,
  description: String,
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', UserSchema);
const Transaction = mongoose.model('Transaction', TransactionSchema);

function generateReferralCode() {
  return Math.random().toString(36).substring(2, 10).toUpperCase();
}

function generateFakeAddress() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz123456789';
  let address = 'T';
  for (let i = 0; i < 33; i++) {
    address += chars[Math.floor(Math.random() * chars.length)];
  }
  return address;
}

function authenticateToken(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  jwt.verify(token, process.env.JWT_SECRET || 'secret123', (err, decoded) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.userId = decoded.userId;
    next();
  });
}

app.post('/api/register', async (req, res) => {
  try {
    const { username, email, password, referralCode } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'All fields required' });
    }
    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(400).json({ error: 'Email already registered' });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    const newReferralCode = generateReferralCode();
    const depositAddress = generateFakeAddress();

    const user = new User({
      username,
      email,
      password: hashedPassword,
      depositAddress,
      referralCode: newReferralCode,
      referredBy: referralCode || null
    });
    await user.save();

    await Transaction.create({
      userId: user._id,
      type: 'bonus',
      amount: 10,
      currency: 'USDT',
      status: 'completed',
      txId: 'SIGNUP_BONUS',
      description: 'Welcome bonus'
    });

    if (referralCode) {
      const referrer = await User.findOne({ referralCode });
      if (referrer) {
        referrer.bonusBalance += 5;
        await referrer.save();
        await Transaction.create({
          userId: referrer._id,
          type: 'referral_bonus',
          amount: 5,
          currency: 'USDT',
          status: 'completed',
          txId: `REF_${user._id}`,
          description: `Referral bonus from ${username}`
        });
      }
    }

    const token = jwt.sign(
      { userId: user._id },
      process.env.JWT_SECRET || 'secret123',
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      message: 'Account created successfully',
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        balance: user.balance,
        bonusBalance: user.bonusBalance,
        totalBalance: user.balance + user.bonusBalance,
        depositAddress: user.depositAddress,
        vipLevel: user.vipLevel,
        referralCode: user.referralCode
      }
    });
  } catch (err) {
    console.error('Register error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Wrong password' });

    const token = jwt.sign(
      { userId: user._id },
      process.env.JWT_SECRET || 'secret123',
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      token,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        balance: user.balance,
        bonusBalance: user.bonusBalance,
        totalBalance: user.balance + user.bonusBalance,
        depositAddress: user.depositAddress,
        vipLevel: user.vipLevel,
        referralCode: user.referralCode,
        totalDeposited: user.totalDeposited,
        totalWithdrawn: user.totalWithdrawn
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/balance', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({
      balance: user.balance,
      bonusBalance: user.bonusBalance,
      totalBalance: user.balance + user.bonusBalance,
      depositAddress: user.depositAddress,
      vipLevel: user.vipLevel,
      username: user.username,
      email: user.email,
      referralCode: user.referralCode,
      totalDeposited: user.totalDeposited,
      totalWithdrawn: user.totalWithdrawn
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/transactions', authenticateToken, async (req, res) => {
  try {
    const txs = await Transaction.find({ userId: req.userId })
      .sort({ createdAt: -1 });
    res.json({ transactions: txs, total: txs.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/withdraw', authenticateToken, async (req, res) => {
  try {
    const { amount, address } = req.body;
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!address) return res.status(400).json({ error: 'Address required' });
    if (amount < 10) return res.status(400).json({ error: 'Minimum 10 USDT' });
    if (user.balance < amount) return res.status(400).json({ error: 'Insufficient balance' });

    const fee = 0.5;
    const amountAfterFee = amount - fee;
    user.balance -= amount;
    user.totalWithdrawn += amountAfterFee;
    await user.save();

    await Transaction.create({
      userId: user._id,
      type: 'withdrawal',
      amount: amountAfterFee,
      fee,
      currency: 'USDT.TRC20',
      status: 'pending',
      txId: `WD_${Date.now()}`,
      address,
      description: 'Withdrawal request'
    });

    res.json({
      success: true,
      message: 'Withdrawal submitted',
      amountSent: amountAfterFee,
      fee
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/referrals', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const referred = await User.find({ referredBy: user.referralCode });
    res.json({
      referralCode: user.referralCode,
      referralLink: `https://bezztrade.base44.app?ref=${user.referralCode}`,
      totalReferred: referred.length,
      totalCommission: referred.length * 5
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/users', async (req, res) => {
  try {
    const adminKey = req.headers['admin-key'];
    if (adminKey !== process.env.ADMIN_KEY) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    const users = await User.find({}).select('-password').sort({ createdAt: -1 });
    res.json({ users, total: users.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/update-balance', async (req, res) => {
  try {
    const adminKey = req.headers['admin-key'];
    if (adminKey !== process.env.ADMIN_KEY) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    const { userId, balance, bonusBalance } = req.body;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (balance !== undefined) user.balance = balance;
    if (bonusBalance !== undefined) user.bonusBalance = bonusBalance;
    await user.save();
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/', async (req, res) => {
  const userCount = await User.countDocuments();
  res.json({
    status: '✅ BezzTrade backend running!',
    users: userCount,
    database: mongoose.connection.readyState === 1 ? '✅ Connected' : '❌ Disconnected',
    timestamp: new Date()
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
