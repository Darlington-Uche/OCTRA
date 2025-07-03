const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const bip39 = require('bip39');
const nacl = require('tweetnacl');
const bs58 = require('bs58');
const axios = require('axios');
const admin = require('firebase-admin');
require('dotenv').config();

// Reconstruct the service account from environment variables
const serviceAccount = {
  type: "service_account",
  project_id: process.env.FB_PROJECT_ID,
  private_key_id: process.env.FB_PRIVATE_KEY_ID,
  private_key: process.env.FB_PRIVATE_KEY.replace(/\\n/g, '\n'),
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

// 1. Create/Load Wallet Endpoint - UPDATED
app.post('/create-wallet', async (req, res) => {
  try {
    const { userId } = req.body;
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



//2. Get User Info Endpoint
app.get('/get-user-info/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const doc = await db.collection('wallets').doc(userId).get();

    if (!doc.exists) {
      return res.status(404).json({ error: 'Wallet not found' });
    }

    const walletData = doc.data();
    
    // Don't return private key or mnemonic in normal info request
    const response = {
      address: walletData.address,
      publicKey: walletData.publicKey,
      createdAt: walletData.createdAt
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

// 4. Get Private Key Endpoint (SECURE - should require authentication)
app.get('/get-keys/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    // In production, you should verify authentication here
    
    const doc = await db.collection('wallets').doc(String(userId)).get();
    if (!doc.exists) {
      return res.status(404).json({ error: 'Wallet not found' });
    }

    const walletData = doc.data();
    
    // Only return sensitive data to authenticated user
    const response = {
      mnemonic: walletData.mnemonic,
      privateKey: walletData.privateKey,
      address: walletData.address
    };

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
// 6. Get Latest Transactions Endpoint - FIXED TIMESTAMP HANDLING
app.get('/get-transactions/:address', async (req, res) => {
  try {
    const { address } = req.params;
    
    const response = await axios.get(`${RPC_ENDPOINT}/address/${address}?limit=5`);
    
    if (!response.data?.recent_transactions) {
      return res.json({
        success: true,
        address,
        transactions: []
      });
    }

    // Safe timestamp formatting
    const formatTimestamp = (ts) => {
      try {
        return ts ? new Date(ts * 1000).toISOString() : 'Unknown';
      } catch {
        return 'Invalid Date';
      }
    };

    const transactions = response.data.recent_transactions.map(tx => ({
      from: tx.from || 'Unknown',
      to: tx.to || 'Unknown',
      amount: parseFloat(tx.amount) || 0,
      timestamp: formatTimestamp(tx.timestamp),
      hash: tx.hash || 'Unknown'
    })).filter(tx => tx.from && tx.to); // Filter out invalid entries

    res.json({
      success: true,
      address,
      transactions: transactions.slice(0, 5)
    });

  } catch (error) {
    console.error('Transaction fetch error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch transactions',
      details: error.response?.data || error.message
    });
  }
});
const PORT = process.env.PORT || 3000;

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
