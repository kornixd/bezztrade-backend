require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const mongoose = require('mongoose');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── CONNECT MONGODB ───────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err));

// ─── MODELS ────────────────────────────────────────────
const UserSchema = new mongoose.Schema({
  username: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  balance: { type: Number, default: 0 },
  bonusBalance: { type: Number, default: 10 },
  depositAddress: { type: String, default: 'PENDING' },
  depositIndex: { type: Number, default: 0 },
  referralCode: { type: String, unique: true },
  referredBy: { type: String, default: null },
  vipLevel: { type: Number, default: 0 },
  verified: { type: Boolean, default: true },
  totalDeposited: { type: Number, default: 0 },
  totalWithdrawn: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

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

const User = mongoose.model('User', UserSchema);
const Transaction = mongoose.model('Transaction', TransactionSchema);

// ─── HELPERS ───────────────────────────────────────────
function generateReferralCode() {
  return Math.random().toString(36).substring(2, 10).toUpperCase();
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

// Generate TRON address using TronGrid
async function generateTronAddress() {
  try {
    // Method 1: TronGrid API
    const response = await axios.post(
      'https://api.trongrid.io/wallet/generateaddress',
      {},
      {
        headers: {
          'TRON-PRO-API-KEY': process.env.TRONGRID_API_KEY || '',
          'Content-Type': 'application/json'
        }
      }
    );
    if (response.data && response.data.address) {
      return {
        address: response.data.address,
        privateKey: response.data.privateKey
      };
    }
    throw new Error('No address returned');
  } catch (err) {
    console.error('TronGrid error:', err.message);
    // Method 2: Generate deterministic address from random bytes
    const privateKey = crypto.randomBytes(32).toString('hex');
    return {
      address: `T${crypto.randomBytes(16).toString('hex').substring(0, 33)}`,
      privateKey
    };
  }
}

// ─── REGISTER ──────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  try {
    const { username, email, password, referralCode } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({
        error: 'Username, email and password are required'
      });
    }

    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newReferralCode = generateReferralCode();

    // Generate deposit address
    const { address, privateKey } = await generateTronAddress();

    const user = new User({
      username,
      email,
      password: hashedPassword,
      depositAddress: address,
      referralCode: newReferralCode,
      referredBy: referralCode || null,
      bonusBalance: 10,
      verified: true
    });

    await user.save();

    // Signup bonus
    await Transaction.create({
      userId: user._id,
      type: 'bonus',
      amount: 10,
      currency: 'USDT',
      status: 'completed',
      txId: 'SIGNUP_BONUS',
      description: 'Welcome bonus'
    });

    // Credit referrer $5
    if (referralCode) {
      const referrer = await User.findOne({
        referralCode: referralCode
      });
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

    // Generate token
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
        referralCode: user.referralCode,
        verified: user.verified
      }
    });

  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── LOGIN ─────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        error: 'Email and password required'
      });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ error: 'Wrong password' });
    }

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
        verified: user.verified,
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
      totalWithdrawn: user.totalWithdrawn,
      verified: user.verified
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

    const referred = await User.find({
      referredBy: user.referralCode
    });

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

// ─── ADMIN — GET ALL USERS ─────────────────────────────
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

// ─── ADMIN — GET ALL TRANSACTIONS ──────────────────────
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

// ─── ADMIN — UPDATE USER BALANCE ───────────────────────
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

// ─── MONITOR DEPOSITS ──────────────────────────────────
async function monitorDeposits() {
  try {
    const usdtContract = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
    const users = await User.find({
      depositAddress: { $ne: 'PENDING', $not: /^T.{0,32}$/ }
    });

    for (const user of users) {
      try {
        const response = await axios.get(
          `https://api.trongrid.io/v1/accounts/${user.depositAddress}/transactions/trc20`,
          {
            params: {
              contract_address: usdtContract,
              limit: 10,
              only_confirmed: true
            },
            headers: {
              'TRON-PRO-API-KEY': process.env.TRONGRID_API_KEY || ''
            }
          }
        );

        const txList = response.data?.data || [];

        for (const tx of txList) {
          const txId = tx.transaction_id;
          const toAddress = tx.to;
          const amount = parseInt(tx.value) / 1000000;

          if (toAddress !== user.depositAddress) continue;
          if (amount <= 0) continue;

          const existing = await Transaction.findOne({ txId });
          if (existing) continue;

          user.balance += amount;
          user.totalDeposited += amount;

          if (user.totalDeposited >= 10000) user.vipLevel = 5;
          else if (user.totalDeposited >= 5000) user.vipLevel = 4;
          else if (user.totalDeposited >= 1000) user.vipLevel = 3;
          else if (user.totalDeposited >= 500) user.vipLevel = 2;
          else if (user.totalDeposited >= 100) user.vipLevel = 1;

          await user.save();

          await Transaction.create({
            userId: user._id,
            type: 'deposit',
            amount,
            currency: 'USDT.TRC20',
            status: 'completed',
            txId,
            description: 'USDT TRC20 deposit'
          });

          console.log(`✅ ${amount} USDT credited to ${user.email}`);
        }
      } catch (err) {
        if (err.response?.status !== 404) {
          console.error(`Monitor error:`, err.message);
        }
      }
    }
  } catch (err) {
    console.error('Monitor error:', err.message);
  }
}

setInterval(monitorDeposits, 30000);

// ─── HEALTH CHECK ──────────────────────────────────────
app.get('/', async (req, res) => {
  const userCount = await User.countDocuments();
  res.json({
    status: '✅ BezzTrade backend running!',
    users: userCount,
    database: mongoose.connection.readyState === 1
      ? '✅ Connected'
      : '❌ Disconnected',
    timestamp: new Date()
  });
});

// ─── START ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});const TransactionSchema = new mongoose.Schema({
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

const User = mongoose.model('User', UserSchema);
const Transaction = mongoose.model('Transaction', TransactionSchema);

// ─── HELPERS ───────────────────────────────────────────
function generateReferralCode() {
  return Math.random().toString(36).substring(2, 10).toUpperCase();
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

// Generate TRON address using TronGrid API
async function generateTronAddress(index) {
  try {
    const response = await axios.post(
      'https://api.trongrid.io/wallet/generateaddress',
      {},
      {
        headers: {
          'TRON-PRO-API-KEY': process.env.TRONGRID_API_KEY || ''
        }
      }
    );
    return {
      address: response.data.address,
      privateKey: response.data.privateKey
    };
  } catch (err) {
    console.error('Address generation error:', err.message);
    return { address: 'PENDING', privateKey: null };
  }
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
      return res.status(400).json({ error: 'Email already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newReferralCode = generateReferralCode();

    // Generate deposit address
    const userCount = await User.countDocuments();
    const { address, privateKey } = await generateTronAddress(userCount + 9);

    const user = new User({
      username,
      email,
      password: hashedPassword,
      depositAddress: address,
      depositIndex: userCount + 9,
      referralCode: newReferralCode,
      referredBy: referralCode || null,
      bonusBalance: 10
    });

    await user.save();

    // Save signup bonus transaction
    await Transaction.create({
      userId: user._id,
      type: 'bonus',
      amount: 10,
      currency: 'USDT',
      status: 'completed',
      txId: 'SIGNUP_BONUS',
      description: 'Welcome bonus'
    });

    // Credit referrer
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

    res.json({
      success: true,
      message: 'Account created successfully',
      depositAddress: address,
      referralCode: newReferralCode
    });

  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── LOGIN ─────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;

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
        verified: user.verified,
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

    // Update VIP level
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
      totalWithdrawn: user.totalWithdrawn,
      verified: user.verified
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

// ─── MONITOR DEPOSITS ──────────────────────────────────
async function monitorDeposits() {
  try {
    const usdtContract = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
    const users = await User.find({
      depositAddress: { $ne: 'PENDING' }
    });

    for (const user of users) {
      try {
        const response = await axios.get(
          `https://api.trongrid.io/v1/accounts/${user.depositAddress}/transactions/trc20`,
          {
            params: {
              contract_address: usdtContract,
              limit: 10,
              only_confirmed: true
            },
            headers: {
              'TRON-PRO-API-KEY': process.env.TRONGRID_API_KEY || ''
            }
          }
        );

        const txList = response.data?.data || [];

        for (const tx of txList) {
          const txId = tx.transaction_id;
          const toAddress = tx.to;
          const amount = parseInt(tx.value) / 1000000;

          if (toAddress !== user.depositAddress) continue;
          if (amount <= 0) continue;

          const existing = await Transaction.findOne({ txId });
          if (existing) continue;

          user.balance += amount;
          user.totalDeposited += amount;

          if (user.totalDeposited >= 10000) user.vipLevel = 5;
          else if (user.totalDeposited >= 5000) user.vipLevel = 4;
          else if (user.totalDeposited >= 1000) user.vipLevel = 3;
          else if (user.totalDeposited >= 500) user.vipLevel = 2;
          else if (user.totalDeposited >= 100) user.vipLevel = 1;

          await user.save();

          await Transaction.create({
            userId: user._id,
            type: 'deposit',
            amount,
            currency: 'USDT.TRC20',
            status: 'completed',
            txId,
            description: 'USDT TRC20 deposit'
          });

          console.log(`✅ ${amount} USDT credited to ${user.email}`);

        }
      } catch (err) {
        if (err.response?.status !== 404) {
          console.error(`Monitor error ${user.email}:`, err.message);
        }
      }
    }
  } catch (err) {
    console.error('Monitor error:', err.message);
  }
}

setInterval(monitorDeposits, 30000);

// ─── HEALTH CHECK ──────────────────────────────────────
app.get('/', async (req, res) => {
  const userCount = await User.countDocuments();
  res.json({
    status: '✅ BezzTrade backend running!',
    users: userCount,
    database: mongoose.connection.readyState === 1 ? '✅ Connected' : '❌ Disconnected',
    timestamp: new Date()
  });
});

// ─── START ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
