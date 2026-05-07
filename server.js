const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const SibApiV3Sdk = require('sib-api-v3-sdk'); 
const axios = require('axios'); 
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express(); // ✅ Pehle app define karna zaroori hai

// --- SAFE FOLDER CREATION LOGIC ---
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
            console.log("⚠️ Removed file and created uploads folder");
        }
    }
} catch (err) {
    console.error("❌ Folder Creation Error:", err.message);
}

// --- MIDDLEWARES ---
app.use(cors({
    origin: '*', 
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use('/uploads', express.static(uploadDir));

// --- DATABASE CONNECTION ---
const pool = require('./db');

// --- SUPABASE CLIENT ---
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

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

// --- MULTER CONFIGURATION (Memory Storage for Supabase) ---
const storage = multer.memoryStorage(); 
const upload = multer({ storage: storage });

// --- OTP Store ---
let otpStore = {}; 

// --- ROUTES ---

// 1. User Registration (Updated to use Memory/Supabase logic if needed, but keeping your path logic safe)
app.post('/api/register', upload.fields([{name:'aadharFront'}, {name:'aadharBack'}]), async (req, res) => {
    try {
        const { fullName, email, mobile, username, password } = req.body;
        // Note: Register mein disk use kar rahe ho toh memory storage handle karna hoga. 
        // Abhi ke liye logic wahi rakha hai jo aapne diya.
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

// 2. SEND OTP
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

// 3. Firebase OTP Verification
app.post('/api/verify-login-firebase', async (req, res) => {
    let { mobile } = req.body;
    try {
        mobile = mobile.toString().replace(/\D/g, ""); 
        if (mobile.length > 10) mobile = mobile.slice(-10);
        const userRes = await pool.query('SELECT id, terms_accepted, is_verified FROM users WHERE mobile_no LIKE $1', [`%${mobile}%`]);
        if (userRes.rows.length === 0) return res.status(404).json({ success: false, error: "Aap registered nahi hain!" });
        const user = userRes.rows[0];
        if (!user.is_verified) return res.status(403).json({ success: false, error: "Account approval pending hai!" });
        res.json({ success: true, userId: user.id, termsAccepted: user.terms_accepted });
    } catch (err) { res.status(500).json({ success: false, error: "Server Error" }); }
});

// 4. Terms Accept
app.post('/api/accept-terms', async (req, res) => {
    const { userId } = req.body;
    try {
        const result = await pool.query('UPDATE users SET terms_accepted = true WHERE id = $1 RETURNING *', [userId]);
        if (result.rowCount > 0) res.json({ success: true, message: "Terms accepted!" });
        else res.status(404).json({ success: false, error: "User nahi mila!" });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// 5. User Details
app.get('/api/user/details/:id', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT username, full_name, mobile_no, wallet_balance, earning_balance, kyc_status, created_at FROM users WHERE id = $1', [req.params.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: "User not found" });
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 6. Game History
app.get('/api/user/game-history/:id', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM battles WHERE creator_id = $1 OR joiner_id = $1 ORDER BY created_at DESC', [req.params.id]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 7. Transaction History
app.get('/api/user/transactions/:id', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC', [req.params.id]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 8. Battle Create
app.post('/api/battles/create', async (req, res) => {
    const { userId, amount } = req.body;
    try {
        await pool.query('BEGIN');
        const userRes = await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [userId]);
        const balance = parseFloat(userRes.rows[0].wallet_balance);
        if (balance < parseFloat(amount)) {
            await pool.query('ROLLBACK');
            return res.status(400).json({ success: false, error: "Paryapt balance nahi hai!" });
        }
        await pool.query('UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id = $2', [amount, userId]);
        const result = await pool.query('INSERT INTO battles (creator_id, amount, status) VALUES ($1, $2, $3) RETURNING id', [userId, amount, 'open']);
        await pool.query('COMMIT');
        res.json({ success: true, battleId: result.rows[0].id });
    } catch (err) { await pool.query('ROLLBACK'); res.status(500).json({ error: err.message }); }
});

// 9. Battle List
app.get('/api/battles/list', async (req, res) => {
    try {
        const result = await pool.query("SELECT b.*, u.username FROM battles b JOIN users u ON b.creator_id = u.id WHERE b.status = 'open' ORDER BY b.created_at DESC");
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: "Server error" }); }
});

// 10. Join Battle
app.post('/api/battles/join', async (req, res) => {
    const { userId, battleId } = req.body;
    try {
        await pool.query('BEGIN');
        const battleRes = await pool.query('SELECT * FROM battles WHERE id = $1 FOR UPDATE', [battleId]);
        const battle = battleRes.rows[0];
        if (!battle || battle.status !== 'open') {
            await pool.query('ROLLBACK');
            return res.status(400).json({ success: false, error: "Battle not available!" });
        }
        const userRes = await pool.query('SELECT wallet_balance FROM users WHERE id = $1', [userId]);
        const userBalance = parseFloat(userRes.rows[0].wallet_balance);
        if (userBalance < parseFloat(battle.amount)) {
            await pool.query('ROLLBACK');
            return res.status(400).json({ success: false, error: "Paryapt balance nahi hai!" });
        }
        await pool.query('UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id = $2', [battle.amount, userId]);
        await pool.query("UPDATE battles SET joiner_id = $1, status = 'joined' WHERE id = $2", [userId, battleId]);
        await pool.query('INSERT INTO transactions (user_id, amount, status) VALUES ($1, $2, $3)', [userId, battle.amount, 'success']);
        await pool.query('COMMIT');
        res.json({ success: true });
    } catch (err) { await pool.query('ROLLBACK'); res.status(500).json({ error: err.message }); }
});

// 11. Battle Details & Update Room
app.get('/api/battles/details/:id', async (req, res) => {
    try {
        const result = await pool.query("SELECT b.*, u1.username as creator_name, u2.username as joiner_name FROM battles b JOIN users u1 ON b.creator_id = u1.id LEFT JOIN users u2 ON b.joiner_id = u2.id WHERE b.id = $1", [req.params.id]);
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/battles/update-room', async (req, res) => {
    const { battleId, roomCode } = req.body;
    try {
        await pool.query("UPDATE battles SET room_code = $1, status = 'playing' WHERE id = $2", [roomCode, battleId]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Server.js mein submit-result route ko update karein
app.post('/api/battles/submit-result', upload.single('screenshot'), async (req, res) => {
    try {
        const { userId, battleId, status } = req.body;
        if (!req.file) return res.status(400).json({ error: "Screenshot missing" });

        // Naya Unique File Name
        const fileExt = path.extname(req.file.originalname);
        const fileName = `${Date.now()}${fileExt}`;

        // Supabase mein upload karein
        const { data, error } = await supabase.storage
            .from('screenshots')
            .upload(fileName, req.file.buffer, {
                contentType: req.file.mimetype,
                upsert: true
            });

        if (error) {
            console.error("Supabase Upload Error:", error);
            throw error;
        }

        // Public URL nikaalein
        const { data: urlData } = supabase.storage
            .from('screenshots')
            .getPublicUrl(fileName);

        const publicUrl = urlData.publicUrl;
        console.log("Image Public URL:", publicUrl);

        // Database mein save karein
        await pool.query(
            'UPDATE battles SET result_status = $1, screenshot_url = $2, status = $3 WHERE id = $4',
            [status, publicUrl, 'pending_approval', battleId]
        );

        res.json({ success: true, message: "Uploaded to Supabase!", url: publicUrl });
    } catch (err) {
        console.error("Final Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// 13. KYC Submission
app.post('/api/user/submit-kyc', async (req, res) => {
    const { userId, bankAcc, ifsc, upiId, whatsapp } = req.body;
    try {
        await pool.query("UPDATE users SET bank_account_no = $1, ifsc_code = $2, upi_id = $3, whatsapp_no = $4, kyc_status = 'pending' WHERE id = $5", [bankAcc, ifsc, upiId, whatsapp, userId]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 14. Withdraw
app.post('/api/withdraw/request', async (req, res) => {
    const { userId, amount } = req.body;
    try {
        const user = (await pool.query('SELECT earning_balance FROM users WHERE id = $1', [userId])).rows[0];
        if (parseFloat(user.earning_balance) < parseFloat(amount)) return res.status(400).json({ message: "Low Balance" });
        await pool.query('BEGIN');
        await pool.query("INSERT INTO withdrawals (user_id, amount, status) VALUES ($1, $2, 'pending')", [userId, amount]);
        await pool.query('UPDATE users SET earning_balance = earning_balance - $1 WHERE id = $2', [amount, userId]);
        await pool.query('COMMIT');
        res.json({ success: true });
    } catch (err) { await pool.query('ROLLBACK'); res.status(500).json({ error: err.message }); }
});

// 15. UPI Gateway
app.post('/api/pay/create-order', async (req, res) => {
    const { amount, userId } = req.body;
    const client_txn_id = "TXN" + Date.now();
    try {
        const userRes = await pool.query('SELECT full_name, mobile_no FROM users WHERE id = $1', [userId]);
        const user = userRes.rows[0] || { full_name: "Ludo Player", mobile_no: "0000000000" };
        const response = await axios.post('https://api.ekqr.in/api/create_order', {
            "key": "b306734d-dac5-48ce-bdd3-d08b8b7d7f38",
            "client_txn_id": client_txn_id,
            "amount": amount.toString(),
            "p_info": "Wallet Topup",
            "customer_name": user.full_name.substring(0, 15),
            "customer_email": "user@gmail.com",
            "customer_mobile": user.mobile_no.replace(/\D/g, "").slice(-10),
            "redirect_url": "https://autotechsolutions25-netizen.github.io/dashboard.html",
            "udf1": userId.toString()
        });
        if (response.data && response.data.status === true) res.json({ success: true, payment_data: response.data.data });
        else res.status(400).json({ success: false, error: response.data.msg || "Gateway Error" });
    } catch (err) { res.status(500).json({ success: false, error: "Gateway Busy" }); }
});

// 16. Admin Routes
app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    if (password === "Praveen@123") res.json({ success: true, token: "ADMIN_SESSION_ACTIVE" });
    else res.status(401).json({ success: false, message: "Galat Password!" });
});

app.get('/api/admin/battles/pending-details', async (req, res) => {
    try {
        const result = await pool.query("SELECT b.*, u1.username as creator_name, u2.username as joiner_name FROM battles b JOIN users u1 ON b.creator_id = u1.id LEFT JOIN users u2 ON b.joiner_id = u2.id WHERE b.status = 'pending_approval' OR (b.status = 'joined' AND b.screenshot_url IS NOT NULL) ORDER BY b.created_at DESC");
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: "Server error" }); }
});

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

app.post('/api/admin/battles/verify-winner', async (req, res) => {
    const { battleId, winnerId } = req.body;
    try {
        await pool.query('BEGIN');
        const battleRes = await pool.query('SELECT amount FROM battles WHERE id = $1', [battleId]);
        const amount = parseFloat(battleRes.rows[0].amount);
        const prize = amount * 1.90;
        await pool.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2', [prize, winnerId]);
        await pool.query("UPDATE battles SET status = 'completed', winner_id = $1 WHERE id = $2", [winnerId, battleId]);
        await pool.query('COMMIT');
        res.json({ success: true });
    } catch (err) { await pool.query('ROLLBACK'); res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/pending-users', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM users WHERE kyc_status = 'pending' ORDER BY created_at DESC");
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/approve-user', async (req, res) => {
    const { userId } = req.body;
    try {
        await pool.query("UPDATE users SET is_verified = true, kyc_status = 'approved' WHERE id = $1", [userId]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/users/list', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, full_name, username, mobile_no, wallet_balance, is_verified FROM users ORDER BY id DESC');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server is live on port: ${PORT}`);
});
