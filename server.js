require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const axios = require('axios');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Simple in-memory database (no MongoDB needed)
const users = {};
const transactions = {};

// ─── HELPERS ──────────────────────────────────────────

function generateId() {
  return Math.random().toString(36).substring(2, 15);
}

function generateReferralCode() {
  return Math.random().toString(36).substring(2, 10).toUpperCase();
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

// ─── COINPAYMENTS ──────────────────────────────────────

async function getCoinpaymentsToken() {
  const clientId = process.env.CP_CLIENT_ID;
  const clientSecret = process.env.CP_CLIENT_SECRET;
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const response = await axios.post(
    'https://oauth.coinpayments.net/oauth/token',
    'grant_type=client_credentials',
    {
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    }
  );
  return response.data.access_token;
}

async function generateDepositAddress() {
  const token = await getCoinpaymentsToken();
  const response = await axios.post(
    'https://a-api.coinpayments.net/api/v1/invoices/payment-address',
    {
      currency: 'USDT.TRC20',
      clientId: process.env.CP_CLIENT_ID
    },
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    }
  );
  return response.data.address;
}

// ─── AUTH ROUTES ───────────────────────────────────────

app.post('/api/register', async (req, res) => {
  try {
    const { username, email, password, referralCode } = req.body;

    if (users[email]) {
      return res.status(400).json({ error: 'Email already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const userId = generateId();
    const newReferralCode = generateReferralCode();

    let depositAddress = 'PENDING';
    try {
      depositAddress = await generateDepositAddress();
    } catch (e) {
      console.log('Address generation failed:', e.message);
    }

    users[email] = {
      id: userId,
      username,
      email,
      password: hashedPassword,
      balance: 0,
      bonusBalance: 10,
      depositAddress,
      referralCode: newReferralCode,
      referredBy: referralCode || null,
      vipLevel: 0,
      verified: false,
      createdAt: new Date()
    };

    transactions[userId] = [{
      id: generateId(),
      type: 'bonus',
      amount: 10,
      currency: 'USDT',
      status: 'completed',
      txId: 'SIGNUP_BONUS',
      createdAt: new Date()
    }];

    res.json({
      success: true,
      message: 'Account created successfully',
      depositAddress,
      referralCode: newReferralCode
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = users[email];

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ error: 'Wrong password' });
    }

    const token = jwt.sign(
      { userId: user.id, email },
      process.env.JWT_SECRET || 'secret123',
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
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
    res.status(500).json({ error: err.message });
  }
});

// ─── USER ROUTES ───────────────────────────────────────

app.get('/api/balance', authenticateToken, (req, res) => {
  const user = Object.values(users).find(u => u.id === req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  res.json({
    balance: user.balance,
    bonusBalance: user.bonusBalance,
    totalBalance: user.balance + user.bonusBalance,
    depositAddress: user.depositAddress,
    vipLevel: user.vipLevel
  });
});

app.get('/api/transactions', authenticateToken, (req, res) => {
  const userTransactions = transactions[req.userId] || [];
  res.json({ transactions: userTransactions.reverse() });
});

// ─── DEPOSIT IPN ───────────────────────────────────────

app.post('/api/ipn', async (req, res) => {
  try {
    const body = req.body;
    const depositAddress = body.address;
    const amount = parseFloat(body.amount || 0);
    const txId = body.txn_id || generateId();
    const status = parseInt(body.status || 0);

    if (status < 100 && status !== 2) {
      return res.send('OK');
    }

    const user = Object.values(users).find(
      u => u.depositAddress === depositAddress
    );

    if (!user) return res.send('OK');

    const alreadyProcessed = (transactions[user.id] || [])
      .find(t => t.txId === txId);
    if (alreadyProcessed) return res.send('OK');

    user.balance += amount;

    if (!transactions[user.id]) transactions[user.id] = [];
    transactions[user.id].push({
      id: generateId(),
      type: 'deposit',
      amount,
      currency: 'USDT.TRC20',
      status: 'completed',
      txId,
      createdAt: new Date()
    });

    // Auto sweep to main wallet
    try {
      const token = await getCoinpaymentsToken();
      await axios.post(
        'https://a-api.coinpayments.net/api/v1/withdrawals',
        {
          amount: amount.toString(),
          currency: 'USDT.TRC20',
          address: process.env.MAIN_WALLET,
          autoConfirm: true
        },
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        }
      );
    } catch (sweepErr) {
      console.log('Sweep error:', sweepErr.message);
    }

    res.send('IPN OK');

  } catch (err) {
    console.error('IPN Error:', err);
    res.status(500).send('Error');
  }
});

// ─── WITHDRAW ──────────────────────────────────────────

app.post('/api/withdraw', authenticateToken, async (req, res) => {
  try {
    const { amount, address } = req.body;
    const user = Object.values(users).find(u => u.id === req.userId);

    if (!user) return res.status(404).json({ error: 'User not found' });
    if (amount < 10) return res.status(400).json({ error: 'Minimum withdrawal is 10 USDT' });
    if (user.balance < amount) return res.status(400).json({ error: 'Insufficient balance' });

    const fee = 0.5;
    const amountAfterFee = amount - fee;

    user.balance -= amount;

    try {
      const token = await getCoinpaymentsToken();
      await axios.post(
        'https://a-api.coinpayments.net/api/v1/withdrawals',
        {
          amount: amountAfterFee.toString(),
          currency: 'USDT.TRC20',
          address,
          autoConfirm: true
        },
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        }
      );
    } catch (withdrawErr) {
      user.balance += amount;
      return res.status(500).json({ error: 'Withdrawal failed' });
    }

    if (!transactions[user.id]) transactions[user.id] = [];
    transactions[user.id].push({
      id: generateId(),
      type: 'withdrawal',
      amount: amountAfterFee,
      currency: 'USDT.TRC20',
      status: 'completed',
      txId: `WD_${Date.now()}`,
      address,
      createdAt: new Date()
    });

    res.json({
      success: true,
      message: 'Withdrawal processed successfully',
      amountSent: amountAfterFee,
      fee
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── HEALTH CHECK ──────────────────────────────────────

app.get('/', (req, res) => {
  res.json({ status: 'BezzTrade backend is running!' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
