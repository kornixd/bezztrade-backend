require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const TronWeb = require('tronweb');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// In-memory database
const users = {};
const transactions = {};
const addressIndex = {};

// TronWeb setup
const tronWeb = new TronWeb({
  fullHost: 'https://api.trongrid.io',
  headers: { 'TRON-PRO-API-KEY': process.env.TRONGRID_API_KEY || '' },
});

// HD Wallet - generate unique address per user
const bip39 = require('bip39');
const hdkey = require('hdkey');

async function generateUserAddress(userIndex) {
  try {
    const mnemonic = process.env.TRON_MNEMONIC;
    const seed = await bip39.mnemonicToSeed(mnemonic);
    const root = hdkey.fromMasterSeed(seed);
    const derived = root.derive(`m/44'/195'/0'/0/${userIndex}`);
    const privateKey = derived.privateKey.toString('hex');
    const address = tronWeb.address.fromPrivateKey(privateKey);
    return { address, privateKey };
  } catch (err) {
    console.error('Address generation error:', err);
    return { address: 'PENDING', privateKey: null };
  }
}

// Get next user index
function getNextIndex() {
  const keys = Object.keys(addressIndex);
  return keys.length;
}

// Helpers
function generateId() {
  return Math.random().toString(36).substring(2, 15);
}

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
      req.email = decoded.email;
      next();
    }
  );
}

// ─── REGISTER ─────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  try {
    const { username, email, password, referralCode } = req.body;

    if (users[email]) {
      return res.status(400).json({ error: 'Email already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const userId = generateId();
    const newReferralCode = generateReferralCode();

    // Generate unique deposit address
    const userIndex = getNextIndex();
    const { address, privateKey } = await generateUserAddress(userIndex);

    addressIndex[address] = { email, userId, privateKey, index: userIndex };

    users[email] = {
      id: userId,
      username,
      email,
      password: hashedPassword,
      balance: 0,
      bonusBalance: 10,
      depositAddress: address,
      depositPrivateKey: privateKey,
      depositIndex: userIndex,
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

    // Credit referrer if valid referral code
    if (referralCode) {
      const referrer = Object.values(users).find(
        u => u.referralCode === referralCode
      );
      if (referrer) {
        referrer.bonusBalance += 5;
        if (!transactions[referrer.id]) transactions[referrer.id] = [];
        transactions[referrer.id].push({
          id: generateId(),
          type: 'referral_bonus',
          amount: 5,
          currency: 'USDT',
          status: 'completed',
          txId: `REF_${userId}`,
          createdAt: new Date()
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
    res.status(500).json({ error: err.message });
  }
});

// ─── LOGIN ─────────────────────────────────────────────
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

// ─── BALANCE ───────────────────────────────────────────
app.get('/api/balance', authenticateToken, (req, res) => {
  const user = Object.values(users).find(u => u.id === req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  res.json({
    balance: user.balance,
    bonusBalance: user.bonusBalance,
    totalBalance: user.balance + user.bonusBalance,
    depositAddress: user.depositAddress,
    vipLevel: user.vipLevel,
    username: user.username
  });
});

// ─── TRANSACTIONS ──────────────────────────────────────
app.get('/api/transactions', authenticateToken, (req, res) => {
  const userTransactions = transactions[req.userId] || [];
  res.json({ transactions: [...userTransactions].reverse() });
});

// ─── WITHDRAW ──────────────────────────────────────────
app.post('/api/withdraw', authenticateToken, async (req, res) => {
  try {
    const { amount, address } = req.body;
    const user = Object.values(users).find(u => u.id === req.userId);

    if (!user) return res.status(404).json({ error: 'User not found' });
    if (amount < 10) return res.status(400).json({ error: 'Minimum withdrawal is 10 USDT' });
    if (user.balance < amount) return res.status(400).json({ error: 'Insufficient balance' });
    if (!address) return res.status(400).json({ error: 'Wallet address required' });

    const fee = 0.5;
    const amountAfterFee = amount - fee;

    user.balance -= amount;

    // Send USDT TRC20 via TronWeb
    try {
      const usdtContractAddress = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
      tronWeb.setPrivateKey(user.depositPrivateKey);

      const contract = await tronWeb.contract().at(usdtContractAddress);
      await contract.transfer(
        address,
        Math.floor(amountAfterFee * 1000000)
      ).send();

    } catch (sendErr) {
      user.balance += amount;
      console.error('Send error:', sendErr);
      return res.status(500).json({ error: 'Withdrawal failed. Please try again.' });
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

// ─── MONITOR DEPOSITS (runs every 30 seconds) ──────────
async function monitorDeposits() {
  const usdtContract = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

  for (const user of Object.values(users)) {
    if (!user.depositAddress || user.depositAddress === 'PENDING') continue;

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

        // Check if already processed
        const alreadyProcessed = (transactions[user.id] || [])
          .find(t => t.txId === txId);
        if (alreadyProcessed) continue;

        // Credit user balance
        user.balance += amount;
        console.log(`Credited ${amount} USDT to ${user.email}`);

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

        // Sweep to main wallet (Bybit address)
        try {
          const tronWebSweep = new TronWeb({
            fullHost: 'https://api.trongrid.io',
            privateKey: user.depositPrivateKey
          });

          const contract = await tronWebSweep
            .contract()
            .at(usdtContract);

          await contract.transfer(
            process.env.MAIN_WALLET,
            Math.floor(amount * 1000000)
          ).send();

          console.log(`Swept ${amount} USDT to main wallet`);

        } catch (sweepErr) {
          console.error('Sweep error:', sweepErr.message);
        }
      }

    } catch (err) {
      console.error(`Monitor error for ${user.email}:`, err.message);
    }
  }
}

// Run monitor every 30 seconds
setInterval(monitorDeposits, 30000);

// ─── HEALTH CHECK ──────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'BezzTrade backend is running!',
    users: Object.keys(users).length,
    timestamp: new Date()
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
