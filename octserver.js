const express = require('express');
require('dotenv').config();
const cors = require('cors');
const crypto = require('crypto');
const bip39 = require('bip39');
const nacl = require('tweetnacl');
const bs58 = require('bs58');
const axios = require('axios');
const admin = require('firebase-admin');

// Reconstruct the service account from environment variables
const serviceAccount = {
  type: "service_account",
  project_id: process.env.FB_PROJECT_ID,
  private_key_id: process.env.FB_PRIVATE_KEY_ID,
  private_key: process.env.FB_PRIVATE_KEY,
  client_email: process.env.FB_CLIENT_EMAIL,
  client_id: process.env.FB_CLIENT_ID,
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url: process.env.FB_CLIENT_CERT_URL
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FB_DATABASE_URL
});
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

const app = express();
app.use(cors());
app.use(express.json());

const RPC_ENDPOINT = "https://octra.network";

// Custom axios instance with headers to avoid 403 errors
const octraAPI = axios.create({
  baseURL: RPC_ENDPOINT,
  headers: {
    'User-Agent': 'OctraWallet/1.0',
    'Accept': 'application/json'
  }
});
let activeRequests = 0;

// Middleware to count active requests
app.use((req, res, next) => {
  activeRequests++;
  res.on('finish', () => {
    activeRequests--;
  });
  next();
});

// Expose load for bots to query
app.get('/server-status', (req, res) => {
  res.json({
    status: 'OK',
    activeRequests,
    capacity: 100,
    availableSlots: Math.max(0, 100 - activeRequests),
    timestamp: new Date().toISOString()
  });
});
//
app.get('/get-all-users', async (req, res) => {
  try {
    const snapshot = await db.collection('wallets').get();
    const users = snapshot.docs.map(doc => ({
      userId: doc.data().userId
    }));
    res.json({ users });
  } catch (error) {
    console.error('Error fetching users:', error.message);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Multi-send endpoint (based)
app.post('/send-multi', async (req, res) => {
  try {
    const { userId, recipients } = req.body; // recipients: [{ address, amount }]

    if (!userId || !Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ error: 'Missing or invalid recipients array' });
    }

    // Fetch wallet
    const doc = await db.collection('wallets').doc(String(userId)).get();
    if (!doc.exists) return res.status(404).json({ error: 'Wallet not found' });

    const wallet = doc.data();
    const privateKey = Buffer.from(wallet.privateKey, 'hex');
    const signingKey = nacl.sign.keyPair.fromSeed(privateKey.slice(0, 32));

    // Get current nonce
    let baseNonce = 0;
    try {
      const resNonce = await axios.get(`${RPC_ENDPOINT}/balance/${wallet.address}`);
      baseNonce = resNonce.data.nonce || 0;
    } catch (err) {
      return res.status(500).json({ error: 'Failed to get nonce', details: err.message });
    }

    // Build transactions
    const txResults = [];
    for (let i = 0; i < recipients.length; i++) {
      const { address, amount } = recipients[i];
      const txNonce = baseNonce + 1 + i;

      const tx = {
        from: wallet.address,
        to_: address,
        amount: Math.round(amount * 1e6).toString(),
        nonce: txNonce,
        ou: amount < 1000 ? "1" : "3",
        timestamp: Date.now() / 1000 + Math.random() * 0.01
      };

      const txForSigning = JSON.stringify(
        Object.fromEntries(Object.entries(tx).filter(([k]) => k !== 'message'))
      );

      const signature = nacl.sign.detached(Buffer.from(txForSigning), signingKey.secretKey);

      const signedTx = {
        ...tx,
        signature: Buffer.from(signature).toString('base64'),
        public_key: Buffer.from(signingKey.publicKey).toString('base64')
      };

      try {
        const resTx = await axios.post(`${RPC_ENDPOINT}/send-tx`, signedTx);
        if (resTx.data.status === 'accepted') {
          await db.collection('transactions').add({
            userId,
            txHash: resTx.data.tx_hash,
            from: wallet.address,
            to: address,
            amount,
            nonce: txNonce,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            status: 'pending'
          });

          txResults.push({ success: true, txHash: resTx.data.tx_hash, recipient: address });
        } else {
          txResults.push({ success: false, error: resTx.data, recipient: address });
        }
      } catch (err) {
        txResults.push({ success: false, error: err.message, recipient: address });
      }

      // Optional short delay to reduce node overload
      await new Promise(res => setTimeout(res, 300));
    }

    const failed = txResults.filter(r => !r.success);
    const successful = txResults.filter(r => r.success);

    res.json({
      successCount: successful.length,
      failedCount: failed.length,
      results: txResults
    });

  } catch (err) {
    console.error('Multi-send error:', err);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});


app.get('/wallets', async (req, res) => {
  try {
    const snapshot = await db.collection('wallets').get();
    const wallets = snapshot.docs.map(doc => doc.data());
    res.json({ wallets });
  } catch (error) {
    console.error('Error fetching wallets:', error.message);
    res.status(500).json({ error: 'Failed to fetch wallets' });
  }
});
app.post('/update-wallet', async (req, res) => {
  const { userId, lastNotifiedTx } = req.body;

  if (!userId || !lastNotifiedTx) {
    return res.status(400).json({ error: 'Missing userId or txHash' });
  }

  try {
    await db.collection('wallets').doc(String(userId)).update({
      lastNotifiedTx,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Error updating wallet:', err.message);
    res.status(500).json({ error: 'Update failed' });
  }
});
// New endpoint to update username for existing wallet
app.post('/update-username', async (req, res) => {
  const { userId, username } = req.body;

  if (!userId || !username) {
    return res.status(400).json({ error: 'Missing userId or username' });
  }

  try {
    const docRef = db.collection('wallets').doc(userId);
    const docSnap = await docRef.get();

    if (!docSnap.exists) {
      return res.status(404).json({ error: 'Wallet not found' });
    }

    await docRef.update({ username });

    return res.json({ success: true, message: 'Username updated successfully' });
  } catch (error) {
    console.error('🔥 Error updating username:', error);
    return res.status(500).json({ error: 'Failed to update username' });
  }
});
// 1. Create/Load Wallet Endpoint - UPDATED
app.post('/create-wallet', async (req, res) => {
  try {
    const { userId, username } = req.body;
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    // Check if wallet already exists
    const walletRef = db.collection('wallets').doc(String(userId));
    const doc = await walletRef.get();

    if (doc.exists) {
      // Wallet exists - return existing data
      const walletData = doc.data();
      return res.json({
        success: true,
        exists: true,
        address: walletData.address,
        publicKey: walletData.publicKey
      });
    }

    // Create new wallet
    const entropy = crypto.randomBytes(16);
    const mnemonic = bip39.entropyToMnemonic(entropy.toString('hex'));
    const seed = bip39.mnemonicToSeedSync(mnemonic);

    const hmac = crypto.createHmac('sha512', Buffer.from('Octra seed', 'utf8'));
    hmac.update(seed);
    const masterKey = hmac.digest();
    const masterPrivateKey = masterKey.slice(0, 32);

    const keyPair = nacl.sign.keyPair.fromSeed(masterPrivateKey);
    const publicKey = Buffer.from(keyPair.publicKey);

    const addressHash = crypto.createHash('sha256').update(publicKey).digest();
    const address = 'oct' + bs58.encode(addressHash);

    const privateKey = Buffer.from(keyPair.secretKey).toString('hex');

    // Store in Firebase
    const walletData = {
      userId: String(userId),
      mnemonic,
      privateKey,
      publicKey: publicKey.toString('hex'),
      address,
      username: username || unknown,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await walletRef.set(walletData);

    res.json({
      success: true,
      exists: false,
      address,
      publicKey: walletData.publicKey
    });
  } catch (error) {
    console.error('Error in create-wallet:', error);
    res.status(500).json({ 
      error: 'Failed to process wallet',
      details: error.message
    });
  }
});


// Update your existing get-user-info endpoint
app.get('/get-user-info/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const doc = await db.collection('wallets').doc(userId).get();

    if (!doc.exists) {
      return res.status(404).json({ error: 'Wallet not found' });
    }

    const walletData = doc.data();

    // Return slightly different data for imported wallets
    const response = {
      address: walletData.address,
      publicKey: walletData.publicKey,
      createdAt: walletData.createdAt,
      username: walletData.username,
      isImported: !walletData.mnemonic // Flag to indicate if this is an imported wallet
    };

    res.json(response);
  } catch (error) {
    console.error('Error getting user info:', error);
    res.status(500).json({ error: 'Failed to get user info' });
  }
});

// 3. Send Transaction Endpoint
app.post('/send-tx', async (req, res) => {
  try {
    const { userId, recipient, amount, message } = req.body;

if (!userId || !recipient || !amount) {
  return res.status(400).json({ error: 'Missing required fields' });
}

// Convert userId to string to avoid Firestore error
const doc = await db.collection('wallets').doc(String(userId)).get();
    if (!doc.exists) {
      return res.status(404).json({ error: 'Wallet not found' });
    }

    const wallet = doc.data();
    const privateKey = Buffer.from(wallet.privateKey, 'hex');
    const signingKey = nacl.sign.keyPair.fromSeed(privateKey.slice(0, 32));

    // Get current nonce
    let currentNonce;
    try {
      const balanceResponse = await axios.get(`${RPC_ENDPOINT}/balance/${wallet.address}`);
      currentNonce = balanceResponse.data.nonce || 0;
    } catch (error) {
      console.error('Error getting nonce:', error);
      currentNonce = 0;
    }

    const txNonce = currentNonce + 1;

    // Prepare transaction
    const tx = {
      from: wallet.address,
      to_: recipient,
      amount: Math.round(amount * 1000000).toString(), // octoshi
      nonce: txNonce,
      ou: amount < 1000 ? "1" : "3", // fee tier
      timestamp: Date.now() / 1000 + Math.random() * 0.01
    };

    if (message) {
      tx.message = message;
    }

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

    // Send transaction
    const response = await axios.post(`${RPC_ENDPOINT}/send-tx`, signedTx);

    if (response.data.status === 'accepted') {
      // Record transaction in Firestore
      await db.collection('transactions').add({
        userId,
        txHash: response.data.tx_hash,
        from: wallet.address,
        to: recipient,
        amount,
        nonce: txNonce,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        status: 'pending'
      });

      res.json({ 
        success: true,
        txHash: response.data.tx_hash,
        explorerUrl: `https://octrascan.io/tx/${response.data.tx_hash}`
      });
    } else {
      res.status(400).json({ error: 'Transaction rejected', details: response.data });
    }
  } catch (error) {
    console.error('Error sending transaction:', error);
    res.status(500).json({ 
      error: 'Failed to send transaction',
      details: error.response?.data || error.message 
    });
  }
});

// Update your existing get-keys endpoint
app.get('/get-keys/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    // Add authentication checks here in production

    const doc = await db.collection('wallets').doc(String(userId)).get();
    if (!doc.exists) {
      return res.status(404).json({ error: 'Wallet not found' });
    }

    const walletData = doc.data();

    const response = {
      privateKey: walletData.privateKey,
      address: walletData.address,
      hasMnemonic: !!walletData.mnemonic // Indicate if mnemonic exists
    };

    // Only include mnemonic if it exists (not for imported wallets)
    if (walletData.mnemonic) {
      response.mnemonic = walletData.mnemonic;
    }

    res.json(response);
  } catch (error) {
    console.error('Error getting keys:', error);
    res.status(500).json({ error: 'Failed to get keys' });
  }
});
//
// 5. Get Balance Endpoint - UPDATED with better error handling
app.get('/get-balance/:address', async (req, res) => {
  try {
    const { address } = req.params;

    // First try to get balance with custom headers
    const balanceResponse = await octraAPI.get(`/balance/${address}`).catch(err => {
      if (err.response?.status === 403) {
        // If 403, try again with different headers
        return octraAPI.get(`/balance/${address}`, {
          headers: {
            'User-Agent': 'Mozilla/5.0',
            'Accept': 'text/plain'
          }
        });
      }
      throw err;
    });

    let balance = 0;
    let nonce = 0;

    // Handle different response formats
    if (typeof balanceResponse.data === 'object') {
      // JSON response
      balance = parseFloat(balanceResponse.data.balance) || 0;
      nonce = parseInt(balanceResponse.data.nonce) || 0;
    } else {
      // Text response
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
    console.error('Error getting balance:', error);

    // Special case for 404 - address not found
    if (error.response?.status === 404) {
      return res.json({
        success: true,
        address: req.params.address,
        balance: 0,
        nonce: 0,
        lastUpdated: new Date().toISOString()
      });
    }

    res.status(500).json({ 
      success: false,
      error: 'Failed to get balance',
      details: error.message 
    });
  }
});
// Updated Transaction History Endpoint
app.get('/get-transactions/:address', async (req, res) => {
  try {
    const { address } = req.params;

    // First get transaction references
    const { status, data } = await axios.get(`${RPC_ENDPOINT}/address/${address}?limit=5`);

    if (status !== 200 || !data?.recent_transactions?.length) {
      return res.json({
        success: true,
        address,
        transactions: []
      });
    }

    // Fetch full transaction details for each
    const txDetails = await Promise.all(
      data.recent_transactions.map(txRef => 
        axios.get(`${RPC_ENDPOINT}/tx/${txRef.hash}`).then(r => r.data)
      )
    );

    // Format transactions according to Octra's structure
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
    console.error('Transaction fetch error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch transactions',
      details: error.message
    });
  }
});


app.post('/switch-wallet', async (req, res) => {
  try {
    const { userId, privateKey } = req.body;

    if (!userId || !privateKey) {
      return res.status(400).json({ error: 'User ID and private key are required' });
    }

    // Validate and extract seed
    const seed = extractSeedFromPrivateKey(privateKey);
    if (!seed) {
      return res.status(400).json({ error: 'Invalid private key format' });
    }

    // Derive keypair and address
    const keyPair = nacl.sign.keyPair.fromSeed(seed);
    const publicKey = Buffer.from(keyPair.publicKey);
    const addressHash = crypto.createHash('sha256').update(publicKey).digest();
    const address = 'oct' + bs58.encode(addressHash);

    // Store wallet
    const walletRef = admin.firestore().collection('wallets').doc(String(userId));
    const walletData = {
      privateKey,
      publicKey: publicKey.toString('hex'),
      address,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      mnemonic: null // since it's imported
    };

    await walletRef.set(walletData, { merge: true });

    return res.json({
      success: true,
      address,
      message: 'Wallet successfully switched'
    });

  } catch (error) {
    console.error('Switch wallet error:', error);
    return res.status(500).json({
      error: 'Failed to switch wallet',
      details: error.message
    });
  }
});

function extractSeedFromPrivateKey(privateKey) {
  try {
    if (typeof privateKey !== 'string') return null;

    let seed;

    if (/^[0-9a-fA-F]{64}$/.test(privateKey)) {
      // 64-char hex (32 bytes)
      seed = Buffer.from(privateKey, 'hex');
    } else if (/^[0-9a-fA-F]{128}$/.test(privateKey)) {
      // 128-char hex (64 bytes) → use first 64 chars
      seed = Buffer.from(privateKey.slice(0, 64), 'hex');
    } else if (/^[A-Za-z0-9+/=]{44}$/.test(privateKey)) {
      // Base64 format (32 bytes)
      seed = Buffer.from(privateKey, 'base64');
    } else {
      return null;
    }

    return seed.length === 32 ? seed : null;
  } catch (err) {
    return null;
  }
}

const PORT = process.env.PORT || 5000;

// 🩺 Health Check Endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', uptime: process.uptime() });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// 🔥 Error Handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});



