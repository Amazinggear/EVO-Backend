const fs = require('fs');
const path = require('path');

function walkDir(dir, callback) {
  fs.readdirSync(dir).forEach(f => {
    const dirPath = path.join(dir, f);
    const isDirectory = fs.statSync(dirPath).isDirectory();
    isDirectory ? walkDir(dirPath, callback) : callback(path.join(dir, f));
  });
}

walkDir(path.join(__dirname, 'src'), function(filePath) {
  if (filePath.endsWith('.js')) {
    let content = fs.readFileSync(filePath, 'utf8');
    
    // Replace require('../../something') with require('../something') 
    // ONLY IF the directory is a direct child of src, like config, utils, middleware, models, database
    const targets = ['config', 'utils', 'middleware', 'database', 'controllers', 'socket', 'routes'];
    
    let changed = false;
    targets.forEach(target => {
      const regex = new RegExp(`require\\(['"\`]\\.\\.\\/\\.\\.\\/${target}\\/([^'"\`]+)['"\`]\\)`, 'g');
      if (regex.test(content)) {
        content = content.replace(regex, `require('../${target}/$1')`);
        changed = true;
      }
    });

    if (changed) {
      fs.writeFileSync(filePath, content, 'utf8');
      console.log(`Fixed paths in ${filePath}`);
    }
  }
});
