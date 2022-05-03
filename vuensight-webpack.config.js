const path = require('path');
module.exports = () => {
   return {
      resolve: {
         alias: {
            src: path.join(__dirname, 'src/'),
            common: path.resolve(__dirname, 'src/common'),
            '@': path.resolve(__dirname, 'src/renderer')
         }
      }
   };
};
