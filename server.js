require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const SibApiV3Sdk = require('sib-api-v3-sdk'); 
const axios = require('axios');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js'); // ✅ Sirf ek baar yahan declare kiya hai

const app = express();

// --- SUPABASE CLIENT SETUP ---
const supabase = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_KEY || '');

// --- SAFE FOLDER CREATION ---
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// --- MIDDLEWARES ---
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE'] }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use('/uploads', express.static(uploadDir));

// --- DATABASE CONNECTION ---
const pool = require('./db');

// --- DATABASE TABLES INITIALIZATION ---
const initDB = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY, full_name TEXT, email TEXT UNIQUE, mobile_no TEXT UNIQUE, username TEXT UNIQUE, password TEXT,
                is_verified BOOLEAN DEFAULT FALSE, wallet_balance DECIMAL DEFAULT 0, earning_balance DECIMAL DEFAULT 0,
                terms_accepted BOOLEAN DEFAULT FALSE, kyc_status TEXT DEFAULT 'not_submitted'
            );
            CREATE TABLE IF NOT EXISTS battles (
                id SERIAL PRIMARY KEY, creator_id INTEGER, joiner_id INTEGER, amount DECIMAL, room_code TEXT, status TEXT,
                result_status TEXT, screenshot_url TEXT, winner_id INTEGER, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS transactions (
                id SERIAL PRIMARY KEY, user_id INTEGER, amount DECIMAL, utr_no TEXT, status TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS withdrawals (
                id SERIAL PRIMARY KEY, user_id INTEGER, amount DECIMAL, status TEXT DEFAULT 'pending', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log("✅ Database Ready.");
    } catch (err) { console.error("❌ DB Init Error:", err.message); }
};
initDB();

// --- MULTER STORAGE ---
const storage = multer.memoryStorage(); 
const upload = multer({ storage: storage });

// ==========================================
// 🚀 ALL ROUTES (Login, Admin, Battles)
// ==========================================

// 1. ADMIN LOGIN
app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    if (password === "Praveen@123") {
        res.json({ success: true, token: "ADMIN_SESSION_ACTIVE" });
    } else {
        res.status(401).json({ success: false, message: "Galat Password!" });
    }
});

// 2. USER LOGIN (Firebase/Mobile)
app.post('/api/verify-login-firebase', async (req, res) => {
    let { mobile } = req.body;
    try {
        mobile = mobile.toString().replace(/\D/g, "").slice(-10);
        const userRes = await pool.query('SELECT id, terms_accepted, is_verified FROM users WHERE mobile_no LIKE $1', [`%${mobile}%`]);
        if (userRes.rows.length === 0) return res.status(404).json({ error: "Registered nahi hain!" });
        const user = userRes.rows[0];
        if (!user.is_verified) return res.status(403).json({ error: "Approval pending!" });
        res.json({ success: true, userId: user.id, termsAccepted: user.terms_accepted });
    } catch (err) { res.status(500).json({ error: "Server Error" }); }
});

// 3. SUBMIT RESULT (Supabase Storage)
app.post('/api/battles/submit-result', upload.single('screenshot'), async (req, res) => {
    try {
        const { userId, battleId, status } = req.body;
        if (!req.file) return res.status(400).json({ error: "Screenshot missing" });

        const fileName = `${Date.now()}_battle.png`;
        const { error: upError } = await supabase.storage
            .from('screenshots')
            .upload(fileName, req.file.buffer, { contentType: req.file.mimetype });

        if (upError) throw upError;
        const { data: urlData } = supabase.storage.from('screenshots').getPublicUrl(fileName);
        
        await pool.query(
            'UPDATE battles SET result_status = $1, screenshot_url = $2, status = $3 WHERE id = $4',
            [status, urlData.publicUrl, 'pending_approval', battleId]
        );
        res.json({ success: true, message: "Uploaded!" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 4. ADMIN MASTER STATS
app.get('/api/admin/master-stats', async (req, res) => {
    try {
        const users = await pool.query('SELECT COUNT(*) FROM users');
        const battles = await pool.query("SELECT COUNT(*) FROM battles WHERE status = 'pending_approval'");
        res.json({
            totalUsers: parseInt(users.rows[0].count),
            pendingBattles: parseInt(battles.rows[0].count)
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server on port: ${PORT}`));
