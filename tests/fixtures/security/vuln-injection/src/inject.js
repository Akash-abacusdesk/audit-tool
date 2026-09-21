const { exec } = require('child_process');
function runCmd(userInput){ return exec('ls ' + userInput); }
function query(db, id){ return db.query('SELECT * FROM users WHERE id=' + id); }
function dynamic(o){ return eval(o.code); }
exports = { runCmd, query, dynamic };