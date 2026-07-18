require('dotenv').config();
const express = require('express');
const app = express();

app.use(express.json());

app.use('/subscriptions', require('./routes/subscriptions'));
app.use('/jobs', require('./routes/jobs'));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Glass marketplace API listening on :${PORT}`));

module.exports = app;
