const express = require('express');
const cors = require('cors'); // CORS ko import kiya
const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();

// 1. CORS Configuration (Ise sabse upar hona chahiye)
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

// Ensure uploads folder exists
if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');

// 4. Database Connection (db.js file se)
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
            CREATE TABLE IF NOT EXISTS transactions (
                id SERIAL PRIMARY KEY,
                user_id INTEGER,
                amount DECIMAL,
                utr_no TEXT,
                status TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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

// File Upload Configuration
const storage = multer.diskStorage({
    destination: './uploads/',
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

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

// 2. OTP Store & Login System
let otpStore = {}; 

app.post('/api/send-otp', async (req, res) => {
    const { mobile } = req.body;
    console.log("OTP Request for:", mobile); // Debugging ke liye

    try {
        // 1. Check User in DB
        const userRes = await pool.query('SELECT * FROM users WHERE mobile_no = $1', [mobile]);
        
        if (userRes.rows.length === 0) {
            return res.status(404).json({ error: "Mobile number registered nahi hai!" });
        }

        const user = userRes.rows[0];

        if (!user.is_verified) {
            return res.status(403).json({ error: "Admin ne abhi aapko approve nahi kiya hai!" });
        }

        // 2. Get Admin Settings
        const settingsRes = await pool.query('SELECT * FROM admin_settings LIMIT 1');
        if (settingsRes.rows.length === 0) {
            return res.status(500).json({ error: "Backend settings missing! admin_settings table check karein." });
        }
        
        const settings = settingsRes.rows[0];
        const otp = Math.floor(100000 + Math.random() * 900000);
        otpStore[mobile] = otp;

        // 3. Send Email
        let transporter = nodemailer.createTransport({
            host: 'smtp.gmail.com',
            port: 465,
            secure: true, // Port 465 ke liye true zaroori hai
            auth: { 
                user: settings.admin_email, 
                pass: settings.smtp_password.replace(/\s+/g, '') 
            },
            connectionTimeout: 10000, // 10 seconds wait karega
            greetingTimeout: 10000,
            socketTimeout: 10000
        });

        await transporter.sendMail({
            from: `"Khel Bhai Ludo" <${settings.admin_email}>`,
            to: user.email,
            subject: 'Login OTP - Khel Bhai Ludo',
            text: `Namaste ${user.full_name}, aapka login OTP hai: ${otp}. Ye OTP sirf 5 minute ke liye valid hai.`
        });

        console.log(`✅ OTP ${otp} sent to ${user.email}`);
        res.json({ success: true, message: "OTP aapke registered email par bhej diya gaya hai!" });

    } catch (err) {
        console.error("❌ OTP Route Error:", err.message);
        res.status(500).json({ error: "Server Error: " + err.message });
    }
});

app.post('/api/verify-login', async (req, res) => {
    const { mobile, otp } = req.body;
    try {
        if (!otpStore[mobile] || otpStore[mobile] != otp) {
            return res.status(400).json({ error: "Invalid or Expired OTP!" });
        }
        const userRes = await pool.query('SELECT id, terms_accepted FROM users WHERE mobile_no = $1', [mobile]);
        if (userRes.rows.length === 0) return res.status(404).json({ error: "User record not found!" });

        const user = userRes.rows[0];
        delete otpStore[mobile];
        res.json({ success: true, userId: user.id, termsAccepted: user.terms_accepted });
    } catch (err) {
        res.status(500).json({ error: "Server error during login." });
    }
});

// 3. Challenge / Battle System
app.post('/api/battles/create', async (req, res) => {
    const { userId, amount } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO battles (creator_id, amount, status) VALUES ($1, $2, $3) RETURNING id', 
            [userId, amount, 'open']
        );
        res.json({ success: true, battleId: result.rows[0].id });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/battles/list', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT b.*, u.username FROM battles b 
            JOIN users u ON b.creator_id = u.id 
            WHERE b.status = 'open' ORDER BY b.created_at DESC
        `);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/battles/join', async (req, res) => {
    const { userId, battleId } = req.body;
    try {
        await pool.query('UPDATE battles SET joiner_id = $1, status = $2 WHERE id = $3', [userId, 'joined', battleId]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 4. KYC & Profile
app.post('/api/user/submit-kyc', async (req, res) => {
    const { userId, bankAcc, ifsc, upiId, whatsapp } = req.body;
    try {
        await pool.query(`
            UPDATE users SET bank_account_no = $1, ifsc_code = $2, upi_id = $3, whatsapp_no = $4, 
            kyc_status = 'pending', kyc_reject_reason = NULL WHERE id = $5`,
            [bankAcc, ifsc, upiId, whatsapp, userId]
        );
        res.json({ success: true, message: "KYC submitted!" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/user/profile/:userId', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.userId]);
        res.json(result.rows[0]);
    } catch (err) { res.status(500).send(err.message); }
});

// 5. Payments & Wallet
const Razorpay = require('razorpay');
const rzp = new Razorpay({
    key_id: 'rzp_test_SflXxOSDMFAolF',
    key_secret: 'N6Ve21b0cUAJZKnaP7ozPiu8'
});

app.post('/api/pay/create-order', async (req, res) => {
    const { amount } = req.body;
    try {
        const order = await rzp.orders.create({ amount: amount * 100, currency: "INR", receipt: "rcpt_" + Date.now() });
        res.json({ success: true, order });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/pay/verify', async (req, res) => {
    const { razorpay_payment_id, amount, userId } = req.body;
    try {
        await pool.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2', [amount, userId]);
        await pool.query('INSERT INTO transactions (user_id, amount, utr_no, status) VALUES ($1, $2, $3, $4)', [userId, amount, razorpay_payment_id, 'success']);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 6. Withdrawal System
app.post('/api/withdraw/request', async (req, res) => {
    const { userId, amount } = req.body;
    try {
        const userResult = await pool.query('SELECT earning_balance FROM users WHERE id = $1', [userId]);
        const user = userResult.rows[0];
        if (parseFloat(user.earning_balance) < parseFloat(amount)) return res.status(400).json({ message: "Low Balance" });

        await pool.query('BEGIN');
        await pool.query('INSERT INTO withdrawals (user_id, amount, status) VALUES ($1, $2, $3)', [userId, amount, 'pending']);
        await pool.query('UPDATE users SET earning_balance = earning_balance - $1 WHERE id = $2', [amount, userId]);
        await pool.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await pool.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    }
});

// 7. Admin Panel Routes
app.get('/api/admin/master-stats', async (req, res) => {
    try {
        const u = await pool.query('SELECT count(*) FROM users');
        const w = await pool.query("SELECT count(*) FROM withdrawals WHERE status = 'pending'");
        const b = await pool.query("SELECT count(*) FROM battles WHERE result_status IS NOT NULL AND status != 'completed'");
        res.json({ totalUsers: u.rows[0].count, pendingWithdrawals: w.rows[0].count, activeBattles: b.rows[0].count });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/withdrawals/pending', async (req, res) => {
    try {
        const result = await pool.query('SELECT w.*, u.username, u.upi_id FROM withdrawals w JOIN users u ON w.user_id = u.id WHERE w.status = \'pending\'');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 8. Server Listen
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server is live on port: ${PORT}`);
});
