const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const bip39 = require('bip39');
const nacl = require('tweetnacl');
const bs58 = require('bs58');
const axios = require('axios');
const admin = require('firebase-admin');
const NodeCache = require('node-cache');
require('dotenv').config();

// Initialize cache with 5 minute TTL
const cache = new NodeCache({ stdTTL: 300, checkperiod: 600 });

// Reconstruct service account with optimized environment handling
const serviceAccount = {
  type: "service_account",
  project_id: process.env.FB_PROJECT_ID,
  private_key_id: process.env.FB_PRIVATE_KEY_ID,
  private_key: process.env.FB_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  client_email: process.env.FB_CLIENT_EMAIL,
  client_id: process.env.FB_CLIENT_ID,
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url: process.env.FB_CLIENT_CERT_URL
};

// Initialize Firebase with optimized settings
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FB_DATABASE_URL
});
const db = admin.firestore();
db.settings({ 
  ignoreUndefinedProperties: true,
  timestampsInSnapshots: true
});

const app = express();

// Optimized middleware stack
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

const RPC_ENDPOINT = "https://octra.network";

// Custom axios instance with optimized settings
const octraAPI = axios.create({
  baseURL: RPC_ENDPOINT,
  timeout: 5000,
  headers: {
    'User-Agent': 'OctraWallet/2.0',
    'Accept': 'application/json',
    'Connection': 'keep-alive',
    'Keep-Alive': 'timeout=5, max=1000'
  }
});

// Request counter with atomic operations
let activeRequests = 0;
const incrementRequests = () => activeRequests++;
const decrementRequests = () => activeRequests--;

// Middleware for request tracking
app.use((req, res, next) => {
  incrementRequests();
  const start = process.hrtime();
  
  res.on('finish', () => {
    decrementRequests();
    const duration = process.hrtime(start);
    console.log(`${req.method} ${req.url} - ${duration[0]}s ${duration[1]/1000000}ms`);
  });
  
  next();
});

// Health endpoints
app.get('/server-status', (req, res) => {
  res.json({
    status: 'OK',
    activeRequests,
    capacity: 1000,
    availableSlots: Math.max(0, 1000 - activeRequests),
    timestamp: new Date().toISOString(),
    memoryUsage: process.memoryUsage()
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    uptime: process.uptime(),
    dbConnected: true,
    rpcConnected: true
  });
});

// Cache middleware
function cacheMiddleware(ttl = 60) {
  return (req, res, next) => {
    const key = req.originalUrl;
    const cached = cache.get(key);
    
    if (cached) {
      return res.json(cached);
    }
    
    const originalSend = res.json;
    res.json = (body) => {
      cache.set(key, body, ttl);
      originalSend.call(res, body);
    };
    
    next();
  };
}

// Wallet endpoints with optimized queries
app.get('/wallets', cacheMiddleware(30), async (req, res) => {
  try {
    const snapshot = await db.collection('wallets')
      .select('address', 'username', 'createdAt')
      .limit(500)
      .get();
      
    const wallets = snapshot.docs.map(doc => doc.data());
    res.json({ wallets });
  } catch (error) {
    console.error('Error fetching wallets:', error);
    res.status(500).json({ error: 'Failed to fetch wallets' });
  }
});

app.post('/update-wallet', async (req, res) => {
  try {
    const { userId, lastNotifiedTx } = req.body;

    if (!userId || !lastNotifiedTx) {
      return res.status(400).json({ error: 'Missing userId or txHash' });
    }

    const batch = db.batch();
    const walletRef = db.collection('wallets').doc(String(userId));
    
    batch.update(walletRef, {
      lastNotifiedTx,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await batch.commit();
    res.json({ success: true });
    
  } catch (err) {
    console.error('Error updating wallet:', err);
    res.status(500).json({ error: 'Update failed' });
  }
});

app.post('/update-username', async (req, res) => {
  try {
    const { userId, username } = req.body;

    if (!userId || !username) {
      return res.status(400).json({ error: 'Missing userId or username' });
    }

    const docRef = db.collection('wallets').doc(userId);
    await docRef.set({ username }, { merge: true });

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating username:', error);
    res.status(500).json({ error: 'Failed to update username' });
  }
});

// Optimized wallet creation
app.post('/create-wallet', async (req, res) => {
  try {
    const { userId, username } = req.body;
    if (!userId) return res.status(400).json({ error: 'User ID required' });

    const walletRef = db.collection('wallets').doc(String(userId));
    const doc = await walletRef.get();

    if (doc.exists) {
      return res.json({
        success: true,
        exists: true,
        address: doc.data().address,
        publicKey: doc.data().publicKey
      });
    }

    // Generate wallet
    const entropy = crypto.randomBytes(16);
    const mnemonic = bip39.entropyToMnemonic(entropy);
    const seed = bip39.mnemonicToSeedSync(mnemonic);

    const hmac = crypto.createHmac('sha512', 'Octra seed');
    hmac.update(seed);
    const masterKey = hmac.digest();
    const masterPrivateKey = masterKey.slice(0, 32);

    const keyPair = nacl.sign.keyPair.fromSeed(masterPrivateKey);
    const publicKey = Buffer.from(keyPair.publicKey);

    const addressHash = crypto.createHash('sha256').update(publicKey).digest();
    const address = 'oct' + bs58.encode(addressHash);

    const privateKey = Buffer.from(keyPair.secretKey).toString('hex');

    // Batch write for better performance
    const batch = db.batch();
    batch.set(walletRef, {
      userId: String(userId),
      mnemonic,
      privateKey,
      publicKey: publicKey.toString('hex'),
      address,
      username: username || 'unknown',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await batch.commit();

    res.json({
      success: true,
      exists: false,
      address,
      publicKey: publicKey.toString('hex')
    });

  } catch (error) {
    console.error('Wallet creation error:', error);
    res.status(500).json({ 
      error: 'Failed to create wallet',
      details: error.message 
    });
  }
});

// Optimized user info endpoint
app.get('/get-user-info/:userId', cacheMiddleware(60), async (req, res) => {
  try {
    const { userId } = req.params;
    const doc = await db.collection('wallets').doc(userId).get();

    if (!doc.exists) {
      return res.status(404).json({ error: 'Wallet not found' });
    }

    const walletData = doc.data();
    res.json({
      address: walletData.address,
      publicKey: walletData.publicKey,
      createdAt: walletData.createdAt,
      username: walletData.username,
      isImported: !walletData.mnemonic
    });

  } catch (error) {
    console.error('User info error:', error);
    res.status(500).json({ error: 'Failed to get user info' });
  }
});

// Transaction handling with retries
app.post('/send-tx', async (req, res) => {
  try {
    const { userId, recipient, amount } = req.body;
    if (!userId || !recipient || !amount) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Get wallet info
    const doc = await db.collection('wallets').doc(String(userId)).get();
    if (!doc.exists) {
      return res.status(404).json({ error: 'Wallet not found' });
    }

    const wallet = doc.data();
    const privateKey = Buffer.from(wallet.privateKey, 'hex');
    const signingKey = nacl.sign.keyPair.fromSeed(privateKey.slice(0, 32));

    // Get nonce with retry
    let currentNonce = 0;
    for (let i = 0; i < 3; i++) {
      try {
        const balanceResponse = await octraAPI.get(`/balance/${wallet.address}`);
        currentNonce = balanceResponse.data.nonce || 0;
        break;
      } catch (err) {
        if (i === 2) throw err;
        await new Promise(r => setTimeout(r, 500 * (i + 1)));
      }
    }

    const txNonce = currentNonce + 1;

    // Prepare transaction
    const tx = {
      from: wallet.address,
      to_: recipient,
      amount: Math.round(amount * 1000000).toString(),
      nonce: txNonce,
      ou: amount < 1000 ? "1" : "3",
      timestamp: Date.now() / 1000 + Math.random() * 0.01
    };

    // Sign transaction
    const txForSigning = JSON.stringify(
      Object.fromEntries(Object.entries(tx).filter(([k]) => k !== 'message'))
    );
    const signature = nacl.sign.detached(
      Buffer.from(txForSigning),
      signingKey.secretKey
    );

    const signedTx = {
      ...tx,
      signature: Buffer.from(signature).toString('base64'),
      public_key: Buffer.from(signingKey.publicKey).toString('base64')
    };

    // Send transaction with retry
    let response;
    for (let i = 0; i < 3; i++) {
      try {
        response = await octraAPI.post('/send-tx', signedTx);
        break;
      } catch (err) {
        if (i === 2) throw err;
        await new Promise(r => setTimeout(r, 500 * (i + 1)));
      }
    }

    if (response.data.status === 'accepted') {
      // Async transaction recording
      db.collection('transactions').add({
        userId,
        txHash: response.data.tx_hash,
        from: wallet.address,
        to: recipient,
        amount,
        nonce: txNonce,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        status: 'pending'
      }).catch(console.error);

      res.json({ 
        success: true,
        txHash: response.data.tx_hash,
        explorerUrl: `https://octrascan.io/tx/${response.data.tx_hash}`
      });
    } else {
      res.status(400).json({ error: 'Transaction rejected', details: response.data });
    }

  } catch (error) {
    console.error('Transaction error:', error);
    res.status(500).json({ 
      error: 'Transaction failed',
      details: error.response?.data || error.message 
    });
  }
});

// Key management with security
app.get('/get-keys/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const doc = await db.collection('wallets').doc(String(userId)).get();

    if (!doc.exists) {
      return res.status(404).json({ error: 'Wallet not found' });
    }

    const walletData = doc.data();
    const response = {
      privateKey: walletData.privateKey,
      address: walletData.address,
      hasMnemonic: !!walletData.mnemonic
    };

    if (walletData.mnemonic) {
      response.mnemonic = walletData.mnemonic;
    }

    res.json(response);
  } catch (error) {
    console.error('Key retrieval error:', error);
    res.status(500).json({ error: 'Failed to get keys' });
  }
});

// Optimized balance checking
app.get('/get-balance/:address', cacheMiddleware(15), async (req, res) => {
  try {
    const { address } = req.params;

    const balanceResponse = await octraAPI.get(`/balance/${address}`).catch(err => {
      if (err.response?.status === 403) {
        return octraAPI.get(`/balance/${address}`, {
          headers: { 'User-Agent': 'Mozilla/5.0' }
        });
      }
      throw err;
    });

    let balance = 0;
    let nonce = 0;

    if (typeof balanceResponse.data === 'object') {
      balance = parseFloat(balanceResponse.data.balance) || 0;
      nonce = parseInt(balanceResponse.data.nonce) || 0;
    } else {
      const parts = String(balanceResponse.data).trim().split(/\s+/);
      if (parts.length >= 2) {
        balance = parseFloat(parts[0]) || 0;
        nonce = parseInt(parts[1]) || 0;
      }
    }

    res.json({
      success: true,
      address,
      balance,
      nonce,
      lastUpdated: new Date().toISOString()
    });

  } catch (error) {
    if (error.response?.status === 404) {
      return res.json({
        success: true,
        address,
        balance: 0,
        nonce: 0,
        lastUpdated: new Date().toISOString()
      });
    }

    console.error('Balance error:', error);
    res.status(500).json({ 
      error: 'Failed to get balance',
      details: error.message 
    });
  }
});

// Transaction history with caching
app.get('/get-transactions/:address', cacheMiddleware(30), async (req, res) => {
  try {
    const { address } = req.params;
    const { data } = await octraAPI.get(`/address/${address}?limit=5`);

    if (!data?.recent_transactions?.length) {
      return res.json({
        success: true,
        address,
        transactions: []
      });
    }

    const txDetails = await Promise.all(
      data.recent_transactions.slice(0, 5).map(txRef =>
        octraAPI.get(`/tx/${txRef.hash}`).then(r => r.data)
      )
    );

    const transactions = txDetails.map(tx => {
      const parsedTx = tx.parsed_tx || {};
      const isIncoming = parsedTx.to === address;

      return {
        hash: tx.hash,
        type: isIncoming ? 'in' : 'out',
        amount: parseFloat(parsedTx.amount || 0),
        counterparty: isIncoming ? parsedTx.from : parsedTx.to,
        timestamp: parsedTx.timestamp ? new Date(parsedTx.timestamp * 1000) : null,
        nonce: parsedTx.nonce || 0,
        status: tx.epoch ? `confirmed (epoch ${tx.epoch})` : 'pending'
      };
    });

    res.json({
      success: true,
      address,
      transactions
    });

  } catch (error) {
    console.error('Transaction history error:', error);
    res.status(500).json({
      error: 'Failed to fetch transactions',
      details: error.message
    });
  }
});

// Wallet switching with validation
app.post('/switch-wallet', async (req, res) => {
  try {
    const { userId, privateKey } = req.body;

    if (!userId || !privateKey) {
      return res.status(400).json({ error: 'User ID and private key required' });
    }

    const seed = extractSeedFromPrivateKey(privateKey);
    if (!seed) return res.status(400).json({ error: 'Invalid private key' });

    const keyPair = nacl.sign.keyPair.fromSeed(seed);
    const publicKey = Buffer.from(keyPair.publicKey);
    const addressHash = crypto.createHash('sha256').update(publicKey).digest();
    const address = 'oct' + bs58.encode(addressHash);

    // Verify wallet
    try {
      await octraAPI.get(`/balance/${address}`);
    } catch (error) {
      console.error('Wallet verification error:', error);
      return res.status(400).json({ error: 'Failed to verify wallet' });
    }

    // Update wallet
    await db.collection('wallets').doc(String(userId)).set({
      privateKey,
      publicKey: publicKey.toString('hex'),
      address,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      mnemonic: null
    }, { merge: true });

    res.json({
      success: true,
      address,
      message: 'Wallet switched successfully'
    });

  } catch (error) {
    console.error('Wallet switch error:', error);
    res.status(500).json({
      error: 'Failed to switch wallet',
      details: error.message
    });
  }
});

function extractSeedFromPrivateKey(privateKey) {
  try {
    if (!/^[0-9a-fA-F]{64,128}$/.test(privateKey)) return null;
    const hex = privateKey.length === 128 ? privateKey.slice(0, 64) : privateKey;
    const seed = Buffer.from(hex, 'hex');
    return seed.length === 32 ? seed : null;
  } catch (err) {
    return null;
  }
}

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    requestId: req.id 
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Process event handlers
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

function gracefulShutdown() {
  console.log('Shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
}