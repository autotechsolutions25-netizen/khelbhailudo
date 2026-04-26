const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // <--- Ye line sabse zaroori hai cloud connection ke liye
    }
});

// Connection check karne ke liye (Logs mein dikhega)
pool.connect((err, client, release) => {
    if (err) {
        return console.error('❌ Database Connection Error:', err.stack);
    }
    console.log('✅ Connected to Supabase Database Successfully!');
    release();
});

module.exports = pool;
