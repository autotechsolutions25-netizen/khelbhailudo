const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const SibApiV3Sdk = require('sib-api-v3-sdk'); 
const axios = require('axios'); // Fast2SMS ke liye zaroori
const multer = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();

// 1. CORS Configuration
app.use(cors({
    origin: ['https://autotechsolutions25-netizen.github.io', 'http://127.0.0.1:5500'], // GitHub aur local dono allow karein
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type']
}));

// 2. Body Parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 3. Static Folders
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');

// 4. Database Connection
const pool = require('./db');

// --- DATABASE TABLES INITIALIZATION ---
const initDB = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                full_name TEXT,
                email TEXT UNIQUE,
                mobile_no TEXT UNIQUE,
                username TEXT UNIQUE,
                password TEXT,
                aadhar_front_url TEXT,
                aadhar_back_url TEXT,
                is_verified BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                terms_accepted BOOLEAN DEFAULT FALSE,
                wallet_balance DECIMAL DEFAULT 0,
                earning_balance DECIMAL DEFAULT 0,
                bank_account_no TEXT,
                ifsc_code TEXT,
                upi_id TEXT,
                whatsapp_no TEXT,
                kyc_status TEXT DEFAULT 'not_submitted',
                kyc_reject_reason TEXT
            );
            CREATE TABLE IF NOT EXISTS admin_settings (
                id SERIAL PRIMARY KEY,
                admin_email TEXT,
                smtp_password TEXT
            );
            CREATE TABLE IF NOT EXISTS battles (
                id SERIAL PRIMARY KEY,
                creator_id INTEGER,
                joiner_id INTEGER,
                amount DECIMAL,
                room_code TEXT,
                status TEXT,
                result_status TEXT,
                screenshot_url TEXT,
                winner_id INTEGER,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS transactions (
                id SERIAL PRIMARY KEY,
                user_id INTEGER,
                amount DECIMAL,
                utr_no TEXT,
                status TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS withdrawals (
                id SERIAL PRIMARY KEY,
                user_id INTEGER,
                amount DECIMAL,
                status TEXT,
                reject_reason TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log("✅ Database Tables Ready.");
    } catch (err) {
        console.error("❌ Database Init Error:", err.message);
    }
};
initDB();

const storage = multer.diskStorage({
    destination: './uploads/',
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

// --- OTP Store (EK BAAR DECLARE KIYA HAI) ---
let otpStore = {}; 

// --- ROUTES ---

// 1. User Registration
app.post('/api/register', upload.fields([{name:'aadharFront'}, {name:'aadharBack'}]), async (req, res) => {
    try {
        const { fullName, email, mobile, username, password } = req.body;
        const front = req.files['aadharFront'] ? `/uploads/${req.files['aadharFront'][0].filename}` : null;
        const back = req.files['aadharBack'] ? `/uploads/${req.files['aadharBack'][0].filename}` : null;

        await pool.query(
            `INSERT INTO users (full_name, email, mobile_no, username, password, aadhar_front_url, aadhar_back_url, is_verified) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, false)`,
            [fullName, email, mobile, username, password, front, back]
        );
        res.json({ success: true });
    } catch (err) {
        console.error("Reg Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// 2. SEND OTP via FAST2SMS (Existing Code - Don't Delete)
app.post('/api/send-otp', async (req, res) => {
    let { mobile } = req.body;
    try {
        mobile = mobile.toString().replace(/\D/g, ""); 
        if (mobile.length > 10) mobile = mobile.slice(-10);
        const userRes = await pool.query('SELECT * FROM users WHERE mobile_no LIKE $1', [`%${mobile}%`]);
        if (userRes.rows.length === 0) return res.status(404).json({ error: "Mobile registered nahi hai!" });
        const otp = Math.floor(100000 + Math.random() * 900000);
        otpStore[mobile] = otp;
        const fast2smsKey = 'CKhGw2uVQxU5JFlBv83OzftpL0ad1Nine6bHSqZRsAXrED4PIo9fvE5CBP3iFtm10IRwguX4qNMnlVjD'; 
        const apiUrl = `https://www.fast2sms.com/dev/bulkV2?authorization=${fast2smsKey}&route=q&message=${encodeURIComponent('Aapka Khel Bhai Ludo OTP hai: ' + otp)}&language=english&flash=0&numbers=${mobile}`;
        const response = await axios.get(apiUrl);
        if (response.data.return) { res.json({ success: true, message: "OTP bhej diya gaya hai!" }); }
        else { res.status(400).json({ error: response.data.message[0] || "SMS failed" }); }
    } catch (err) { res.status(500).json({ error: "Service Busy" }); }
});

// NEW ROUTE: Firebase OTP Verification Check
app.post('/api/verify-login-firebase', async (req, res) => {
    let { mobile } = req.body;
    try {
        // Mobile cleaning: Agar +91 hai toh hata do, sirf aakhri 10 digits lo
        mobile = mobile.toString().replace(/\D/g, ""); 
        if (mobile.length > 10) mobile = mobile.slice(-10);

        console.log("Checking DB for cleaned mobile:", mobile);

        const userRes = await pool.query('SELECT id, terms_accepted, is_verified FROM users WHERE mobile_no LIKE $1', [`%${mobile}%`]);
        
        if (userRes.rows.length === 0) {
            return res.status(404).json({ success: false, error: "Aap registered nahi hain!" });
        }

        const user = userRes.rows[0];
        
        if (!user.is_verified) {
            return res.status(403).json({ success: false, error: "Account approval pending hai!" });
        }

        res.json({ 
            success: true, 
            userId: user.id, 
            termsAccepted: user.terms_accepted 
        });
    } catch (err) {
        console.error("Firebase Login Error:", err.message);
        res.status(500).json({ success: false, error: "Server Error" });
    }
});



// --- 1. Terms Accept Karne Ka Route ---
app.post('/api/accept-terms', async (req, res) => {
    const { userId } = req.body;
    
    console.log("Terms acceptance request for User ID:", userId);

    try {
        // Database mein terms_accepted ko true set karein
        const result = await pool.query(
            'UPDATE users SET terms_accepted = true WHERE id = $1 RETURNING *', 
            [userId]
        );

        if (result.rowCount > 0) {
            console.log(`✅ User ${userId} ne terms accept kar liye hain.`);
            res.json({ success: true, message: "Terms accepted successfully!" });
        } else {
            res.status(404).json({ success: false, error: "User nahi mila!" });
        }
    } catch (err) {
        console.error("❌ Terms Update Error:", err.message);
        res.status(500).json({ success: false, error: "Database error: " + err.message });
    }
});






// Purana Verify Login (OTP Store wala)
app.post('/api/verify-login', async (req, res) => {
    const { mobile, otp } = req.body;
    try {
        if (!otpStore[mobile] || otpStore[mobile] != otp) return res.status(400).json({ error: "Invalid OTP!" });
        const userRes = await pool.query('SELECT id, terms_accepted FROM users WHERE mobile_no = $1', [mobile]);
        const user = userRes.rows[0];
        delete otpStore[mobile];
        res.json({ success: true, userId: user.id, termsAccepted: user.terms_accepted });
    } catch (err) { res.status(500).json({ error: "Server error" }); }
});


// --- 1. User Profile Detail (Naam aur Balance ke liye) ---
app.get('/api/user/details/:id', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT full_name, wallet_balance, earning_balance FROM users WHERE id = $1', 
            [req.params.id]
        );
        if (result.rows.length > 0) res.json(result.rows[0]);
        else res.status(404).json({ error: "User not found" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 2. Game History (Play Ludo/Win click ke liye) ---
app.get('/api/user/game-history/:id', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM battles WHERE creator_id = $1 OR joiner_id = $1 ORDER BY created_at DESC', 
            [req.params.id]
        );
        res.json(result.rows); // Agar khali hai toh [] jayega
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 3. Transaction History (Wallet transaction ke liye) ---
app.get('/api/user/transactions/:id', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC', 
            [req.params.id]
        );
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});





// 3. Battles
app.post('/api/battles/create', async (req, res) => {
    const { userId, amount } = req.body;
    try {
        const result = await pool.query('INSERT INTO battles (creator_id, amount, status) VALUES ($1, $2, $3) RETURNING id', [userId, amount, 'open']);
        res.json({ success: true, battleId: result.rows[0].id });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/battles/list', async (req, res) => {
    try {
        const result = await pool.query('SELECT b.*, u.username FROM battles b JOIN users u ON b.creator_id = u.id WHERE b.status = \'open\' ORDER BY b.created_at DESC');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/user/submit-kyc', async (req, res) => {
    const { userId, bankAcc, ifsc, upiId, whatsapp } = req.body;
    try {
        await pool.query('UPDATE users SET bank_account_no = $1, ifsc_code = $2, upi_id = $3, whatsapp_no = $4, kyc_status = \'pending\' WHERE id = $5', [bankAcc, ifsc, upiId, whatsapp, userId]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 4. Payments (Razorpay)
const Razorpay = require('razorpay');
const rzp = new Razorpay({ key_id: 'rzp_test_SflXxOSDMFAolF', key_secret: 'N6Ve21b0cUAJZKnaP7ozPiu8' });

app.post('/api/pay/create-order', async (req, res) => {
    const { amount } = req.body;
    try {
        const order = await rzp.orders.create({ amount: amount * 100, currency: "INR", receipt: "rcpt_" + Date.now() });
        res.json({ success: true, order });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 5. Withdrawals
app.post('/api/withdraw/request', async (req, res) => {
    const { userId, amount } = req.body;
    try {
        const user = (await pool.query('SELECT earning_balance FROM users WHERE id = $1', [userId])).rows[0];
        if (parseFloat(user.earning_balance) < parseFloat(amount)) return res.status(400).json({ message: "Low Balance" });
        await pool.query('BEGIN');
        await pool.query('INSERT INTO withdrawals (user_id, amount, status) VALUES ($1, $2, $3)', [userId, amount, 'pending']);
        await pool.query('UPDATE users SET earning_balance = earning_balance - $1 WHERE id = $2', [amount, userId]);
        await pool.query('COMMIT');
        res.json({ success: true });
    } catch (err) { await pool.query('ROLLBACK'); res.status(500).json({ error: err.message }); }
});


// UPIGateway Order Create
app.post('/api/pay/create-order', async (req, res) => {
    const { amount, userId } = req.body;
    const client_txn_id = "TXN" + Date.now();

    try {
        const response = await axios.post('https://api.ekqr.in/api/create_order', {
            "key": "b306734d-dac5-48ce-bdd3-d08b8b7d7f38", // Screenshot wali Key
            "client_txn_id": client_txn_id,
            "amount": amount.toString(),
            "p_info": "Wallet Topup",
            "customer_name": "Ludo Player",
            "customer_email": "user@gmail.com",
            "customer_mobile": "7079950417",
            "redirect_url": "https://autotechsolutions25-netizen.github.io/dashboard.html",
            "udf1": userId.toString()
        });

        console.log("UPIGateway Response:", response.data); // Render Logs mein dekhein kya aa raha hai

        // Yahan check karein ki data aur payment_url dono hain ya nahi
        if (response.data && response.data.status === true && response.data.data && response.data.data.payment_url) {
            res.json({ success: true, payment_data: response.data.data });
        } else {
            res.status(400).json({ 
                success: false, 
                error: response.data.msg || "Gateway response mein payment_url nahi mila" 
            });
        }
    } catch (err) {
        console.error("Gateway Error:", err.response ? err.response.data : err.message);
        res.status(500).json({ success: false, error: "Gateway connection failed" });
    }
});



app.post('/api/webhook/upigateway', async (req, res) => {
    const { status, client_txn_id, amount, udf1 } = req.body; // udf1 mein humne userId bheja tha

    if (status === 'success') {
        try {
            // 1. Transaction record update karein
            await pool.query('INSERT INTO transactions (user_id, amount, utr_no, status, type) VALUES ($1, $2, $3, $4, $5)', 
            [udf1, amount, client_txn_id, 'success', 'deposit']);

            // 2. User ka Wallet Update karein
            await pool.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2', [amount, udf1]);

            console.log(`✅ Wallet Updated for User ${udf1}: ₹${amount}`);
            res.send('OK'); // Gateway ko batayein ki humne data process kar liya
        } catch (err) {
            console.error("Webhook Error:", err.message);
            res.status(500).send('Database Error');
        }
    } else {
        res.send('Not Success');
    }
});




const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server is live on port: ${PORT}`);
});
