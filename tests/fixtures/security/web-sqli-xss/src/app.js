const db = require('./db');
const express = require('express');
const app = express();
app.get('/user', (req, res) => {
  const id = req.query.id;
  // SQLi: string concat into query
  db.query('SELECT name, email FROM users WHERE id = ' + id, (e, rows) => res.json(rows));
});
app.get('/search', (req, res) => {
  const q = req.query.q;
  // XSS: unescaped reflection into HTML
  res.send('<div>You searched for: ' + q + '</div>');
});
app.listen(3000);