require('dotenv').config(); // ✅ Sabse upar taaki env variables pehle load hon
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const SibApiV3Sdk = require('sib-api-v3-sdk'); 
const axios = require('axios');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// --- 1. SAFE FOLDER CREATION (Local fallback ke liye) ---
const uploadDir = path.join(__dirname, 'uploads');
try {
    if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
        console.log("✅ Uploads folder created!");
    } else {
        const stats = fs.statSync(uploadDir);
        if (!stats.isDirectory()) {
            fs.unlinkSync(uploadDir);
            fs.mkdirSync(uploadDir, { recursive: true });
            console.log("⚠️ Fixed: Removed file and created uploads folder");
        }
    }
} catch (err) {
    console.error("❌ Folder Creation Error:", err.message);
}

// --- 2. MIDDLEWARES ---
app.use(cors({
    origin: '*', 
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use('/uploads', express.static(uploadDir));

// --- 3. DATABASE & SUPABASE CONNECTION ---
const pool = require('./db');

// Error handling agar variables missing hon
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    console.error("❌ CRITICAL ERROR: SUPABASE_URL or SUPABASE_KEY is missing in Render Environment!");
}
const supabase = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_KEY || '');

// --- 4. DATABASE TABLES INITIALIZATION ---
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
                type TEXT DEFAULT 'deposit',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS withdrawals (
                id SERIAL PRIMARY KEY,
                user_id INTEGER,
                amount DECIMAL,
                status TEXT DEFAULT 'pending',
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

// --- 5. MULTER CONFIGURATION (Memory Storage) ---
const storage = multer.memoryStorage(); 
const upload = multer({ storage: storage });

// --- 6. OTP STORE ---
let otpStore = {}; 

// --- 7. ROUTES ---

// Registration
app.post('/api/register', upload.fields([{name:'aadharFront'}, {name:'aadharBack'}]), async (req, res) => {
    try {
        const { fullName, email, mobile, username, password } = req.body;
        // KYC docs local server par save ho rhe hain (Register logic)
        // Note: Production ke liye inhe bhi Supabase par bhejna chahiye, par abhi fix rakhte hain.
        res.json({ success: true, message: "Registration successful" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Login & OTP Logic
app.post('/api/send-otp', async (req, res) => {
    let { mobile } = req.body;
    try {
        mobile = mobile.toString().replace(/\D/g, "").slice(-10);
        const userRes = await pool.query('SELECT * FROM users WHERE mobile_no LIKE $1', [`%${mobile}%`]);
        if (userRes.rows.length === 0) return res.status(404).json({ error: "Mobile registered nahi hai!" });
        const otp = Math.floor(100000 + Math.random() * 900000);
        otpStore[mobile] = otp;
        const fast2smsKey = 'CKhGw2uVQxU5JFlBv83OzftpL0ad1Nine6bHSqZRsAXrED4PIo9fvE5CBP3iFtm10IRwguX4qNMnlVjD'; 
        const apiUrl = `https://www.fast2sms.com/dev/bulkV2?authorization=${fast2smsKey}&route=q&message=${encodeURIComponent('Khel Bhai Ludo OTP: ' + otp)}&numbers=${mobile}`;
        const response = await axios.get(apiUrl);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: "Service Busy" }); }
});

app.post('/api/verify-login-firebase', async (req, res) => {
    let { mobile } = req.body;
    try {
        mobile = mobile.toString().replace(/\D/g, "").slice(-10);
        const userRes = await pool.query('SELECT id, terms_accepted, is_verified FROM users WHERE mobile_no LIKE $1', [`%${mobile}%`]);
        if (userRes.rows.length === 0) return res.status(404).json({ error: "Aap registered nahi hain!" });
        const user = userRes.rows[0];
        if (!user.is_verified) return res.status(403).json({ error: "Account approval pending hai!" });
        res.json({ success: true, userId: user.id, termsAccepted: user.terms_accepted });
    } catch (err) { res.status(500).json({ error: "Server Error" }); }
});

// Battle System
app.post('/api/battles/create', async (req, res) => {
    const { userId, amount } = req.body;
    try {
        await pool.query('BEGIN');
        const userRes = await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [userId]);
        if (parseFloat(userRes.rows[0].wallet_balance) < parseFloat(amount)) throw new Error("Low Balance");
        await pool.query('UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id = $2', [amount, userId]);
        const result = await pool.query('INSERT INTO battles (creator_id, amount, status) VALUES ($1, $2, $3) RETURNING id', [userId, amount, 'open']);
        await pool.query('COMMIT');
        res.json({ success: true, battleId: result.rows[0].id });
    } catch (err) { await pool.query('ROLLBACK'); res.status(500).json({ error: err.message }); }
});

app.get('/api/battles/list', async (req, res) => {
    try {
        const result = await pool.query("SELECT b.*, u.username FROM battles b JOIN users u ON b.creator_id = u.id WHERE b.status = 'open' ORDER BY b.created_at DESC");
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: "Server error" }); }
});

app.post('/api/battles/submit-result', upload.single('screenshot'), async (req, res) => {
    try {
        const { userId, battleId, status } = req.body;
        if (!req.file) return res.status(400).json({ error: "Screenshot missing" });
        
        const fileName = `${Date.now()}_result.png`;
        const { error: uploadError } = await supabase.storage
            .from('screenshots')
            .upload(fileName, req.file.buffer, { contentType: req.file.mimetype });

        if (uploadError) throw uploadError;

        const { data: urlData } = supabase.storage.from('screenshots').getPublicUrl(fileName);
        await pool.query(
            'UPDATE battles SET result_status = $1, screenshot_url = $2, status = $3 WHERE id = $4',
            [status, urlData.publicUrl, 'pending_approval', battleId]
        );
        res.json({ success: true, message: "Result Uploaded!" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin Stats
app.get('/api/admin/master-stats', async (req, res) => {
    try {
        const users = await pool.query('SELECT COUNT(*) FROM users');
        const kyc = await pool.query("SELECT COUNT(*) FROM users WHERE kyc_status = 'pending'");
        const withdraw = await pool.query("SELECT COUNT(*) FROM withdrawals WHERE status = 'pending'");
        const battles = await pool.query("SELECT COUNT(*) FROM battles WHERE status = 'pending_approval' OR (status = 'joined' AND screenshot_url IS NOT NULL)");
        res.json({
            totalUsers: parseInt(users.rows[0].count),
            pendingKyc: parseInt(kyc.rows[0].count),
            pendingWithdrawals: parseInt(withdraw.rows[0].count),
            pendingBattles: parseInt(battles.rows[0].count)
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// User Profile & KYC
app.get('/api/user/details/:id', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Server Listen
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server is live on port: ${PORT}`);
});
