const chalk = require('chalk');
const moment = require('moment');

const now = () => {
    return `[${moment().format('DD-MM|HH:mm:ss')}]`;
};

const error = (...data) => {
    console.log(chalk.bold.red('ERROR'), now(), ...data);

    process.exit(1);
};

const warning = (...data) => {
    console.log(chalk.yellow('WARN'), now(), ...data);
};

const info = (...data) => {
    console.log(chalk.green('INFO'), now(), ...data);
};

const arg = (message, value) => `${chalk.green(message)}=${value}`;

module.exports = {
    error,
    warning,
    info,
    arg
};
