require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const TronWeb = require('tronweb');
const bip39 = require('bip39');
const hdkey = require('hdkey');

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
  headers: {
    'TRON-PRO-API-KEY': process.env.TRONGRID_API_KEY || ''
  }
});

// ─── GENERATE UNIQUE ADDRESS PER USER ─────────────────
async function generateUserAddress(userIndex) {
  try {
    const mnemonic = process.env.TRON_MNEMONIC;
    if (!mnemonic) throw new Error('No mnemonic set');

    const seed = await bip39.mnemonicToSeed(mnemonic);
    const root = hdkey.fromMasterSeed(seed);
    const derived = root.derive(`m/44'/195'/0'/0/${userIndex}`);
    const privateKey = derived.privateKey.toString('hex');
    const address = tronWeb.address.fromPrivateKey(privateKey);

    return { address, privateKey };
  } catch (err) {
    console.error('Address generation error:', err.message);
    return { address: 'PENDING', privateKey: null };
  }
}

// Start from index 9 to avoid conflict with personal wallets
function getNextIndex() {
  const keys = Object.keys(addressIndex);
  return keys.length + 9;
}

// ─── HELPERS ───────────────────────────────────────────
function generateId() {
  return Math.random().toString(36).substring(2, 15);
}

function generateReferralCode() {
  return Math.random().toString(36).substring(2, 10).toUpperCase();
}

function authenticateToken(req, res, ne
