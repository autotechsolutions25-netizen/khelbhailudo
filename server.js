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
    origin: 'https://autotechsolutions25-netizen.github.io', 
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

// 2. SEND OTP via FAST2SMS
app.post('/api/send-otp', async (req, res) => {
    let { mobile } = req.body;
    console.log("SMS OTP Request for:", mobile);

    try {
        // 1. Mobile Number Cleaning (Sirf 10 digits rakhega)
        // Agar user ne +91 ya space dala hai toh use hata dega
        mobile = mobile.toString().replace(/\D/g, ""); 
        if (mobile.length > 10) mobile = mobile.slice(-10);

        // 2. Database mein user check karein
        const userRes = await pool.query('SELECT * FROM users WHERE mobile_no LIKE $1', [`%${mobile}%`]);
        if (userRes.rows.length === 0) {
            return res.status(404).json({ error: "Mobile number registered nahi hai!" });
        }

        const user = userRes.rows[0];
        if (!user.is_verified) {
            return res.status(403).json({ error: "Admin ne abhi aapko approve nahi kiya hai!" });
        }

        // 3. 6-digit OTP Generate karein
        const otp = Math.floor(100000 + Math.random() * 900000);
        otpStore[mobile] = otp;

        // 4. FAST2SMS API CALL (Updated with Headers for Safety)
        const fast2smsKey = 'CKhGw2uVQxU5JFlBv83OzftpL0ad1Nine6bHSqZRsAXrED4PIo9fvE5CBP3iFtm10IRwguX4qNMnlVjD'; 
        
        const response = await axios({
            method: 'get',
            url: 'https://www.fast2sms.com/dev/bulkV2',
            params: {
                "authorization": fast2smsKey,
                "variables_values": otp.toString(),
                "route": "otp",
                "numbers": mobile
            },
            headers: {
                "cache-control": "no-cache"
            }
        });

        if (response.data.return) {
            console.log(`✅ SMS Sent Successfully to ${mobile}: OTP is ${otp}`);
            res.json({ success: true, message: "OTP aapke mobile par bhej diya gaya hai!" });
        } else {
            // Agar Fast2SMS se koi message aaye toh wo dikhayega
            console.error("Fast2SMS Reject Reason:", response.data.message);
            res.status(400).json({ error: response.data.message[0] || "Fast2SMS Error" });
        }

    } catch (err) {
        console.error("❌ SMS Error Details:", err.response ? err.response.data : err.message);
        res.status(500).json({ error: "SMS Error: " + (err.response ? JSON.stringify(err.response.data) : err.message) });
    }
});

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

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server is live on port: ${PORT}`);
});
