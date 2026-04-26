const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // Cloud database ke liye ye mandatory hai
    }
});

// Ye check karne ke liye ki connect hua ya nahi
pool.connect((err, client, release) => {
    if (err) {
        return console.error('❌ Connection Failed at db.js:', err.stack);
    }
    console.log('✅ Connected to Supabase Successfully!');
    release();
});

module.exports = pool;
