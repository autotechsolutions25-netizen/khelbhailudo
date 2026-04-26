const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // Ye line Cloud (Supabase) ke liye mandatory hai
    }
});

module.exports = pool;
