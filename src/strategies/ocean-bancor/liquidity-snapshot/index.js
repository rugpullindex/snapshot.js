const fs = require('fs');
const path = require('path');
const mkdirp = require('mkdirp');
const BN = require('bn.js');
const Web3 = require('web3');
const Contract = require('web3-eth-contract');
const { set, get } = require('lodash');

const { info, error, warning, arg } = require('./logger');

// *** User-provided configuration *** ///
// const PROVIDER_URL = 'ws://localhost:8545';
const PROVIDER_URL = 'https://mainnet.infura.io/v3/c31eb1dca6d3480bbcbab4d01584251d'
const TARGET_BLOCK = 0;
const POOL_TOKEN_ADDRESS = '0xCDfF066eDf8a770E9b6A7aE12F7CFD3DbA0011B5'; // OCEAN-BNT
// *** User-provided configuration *** ///

const GENESIS_BLOCK_NUMBER = 11039642;
const ABI_DIR = path.resolve(__dirname, './abi');
const LIQUIDITY_PROTECTION_STORE_ADDRESS = '0xf5fab5dbd2f3bf675de4cb76517d4767013cfb55';
const LIQUIDITY_PROTECTION_STORE_ABI = 'LiquidityProtectionStore.json';
const DB_DIR = path.resolve(__dirname, './data');
const DB_PATH = path.join(DB_DIR, 'liquidity.json');

const BATCH_SIZE = 500;

const main = async () => {
    const strcmpi = (address1, address2) => {
        return address1.toLowerCase() === address2.toLowerCase();
    };

    const getPosition = async (id, blockNumber, store) => {
        const position = await store.methods.protectedLiquidity(id).call({}, blockNumber);

        return {
            id,
            provider: position[0],
            poolToken: position[1],
            reserveToken: position[2],
            poolAmount: position[3],
            reserveAmount: position[4],
            reserveRateN: position[5],
            reserveRateD: position[6],
            timestamp: position[7]
        };
    };

    const getProtectionLiquidityChanges = async (data, fromBlock, toBlock, web3, store) => {
        if (!POOL_TOKEN_ADDRESS) {
            error('POOL_TOKEN_ADDRESS is undefined');
        }

        info(
            'Getting protected liquidity for',
            arg('poolToken', POOL_TOKEN_ADDRESS),
            'from',
            arg('fromBlock', fromBlock),
            'to',
            arg('toBlock', toBlock)
        );

        set(data, 'providers', {});
        set(data, 'lastBlockNumber', 0);

        let { providers, lastBlockNumber } = data;

        let eventCount = 0;
        for (let i = fromBlock; i < toBlock; i += BATCH_SIZE) {
            const endBlock = Math.min(i + BATCH_SIZE - 1, toBlock);

            info(
                'Querying all protection change events from',
                arg('startBlock', i),
                'to',
                arg('endBlock', endBlock),
                'in batches of',
                arg('batchSize', BATCH_SIZE),
                'blocks'
            );

            const events = await store.getPastEvents('allEvents', {
                fromBlock: i,
                toBlock: endBlock
            });

            for (const event of events) {
                const { blockNumber, returnValues, transactionHash } = event;
                const block = await web3.eth.getBlock(blockNumber);
                const { timestamp } = block;

                switch (event.event) {
                    case 'ProtectionAdded': {
                        const provider = returnValues._provider;
                        const poolToken = returnValues._poolToken;
                        const reserveToken = returnValues._reserveToken;
                        const reserveAmount = returnValues._reserveAmount;

                        if (!strcmpi(POOL_TOKEN_ADDRESS, poolToken)) {
                            continue;
                        }

                        info(
                            'Found ProtectionAdded event at block',
                            arg('blockNumber', blockNumber),
                            arg('provider', provider),
                            arg('poolToken', poolToken),
                            arg('reserveToken', reserveToken),
                            arg('reserveAmount', reserveAmount),
                            arg('timestamp', timestamp),
                            arg('tx', transactionHash)
                        );

                        const totalProviderAmount = get(providers, [provider, poolToken, reserveToken]) || 0;
                        set(
                            providers,
                            [provider, poolToken, reserveToken],
                            new BN(totalProviderAmount).add(new BN(reserveAmount)).toString()
                        );

                        eventCount++;

                        lastBlockNumber = blockNumber;

                        break;
                    }

                    case 'ProtectionUpdated': {
                        const provider = returnValues._provider;
                        const prevReserveAmount = returnValues._prevReserveAmount;
                        const newReserveAmount = returnValues._newReserveAmount;
                        const prevPoolAmount = returnValues._prevPoolAmount;
                        const newPoolAmount = returnValues._newPoolAmount;

                        // Try to find the pool and reserves tokens by matching the position in a previous block.
                        // Please note that we are assuming that a single position wasn't added and removed in the
                        // same block.
                        const matches = [];
                        const prevBlock = blockNumber - 1;
                        let ids = await store.methods.protectedLiquidityIds(provider).call({}, prevBlock);
                        for (const id of ids) {
                            const position = await getPosition(id, prevBlock, store);
                            if (
                                new BN(position.reserveAmount).eq(new BN(prevReserveAmount)) &&
                                new BN(position.poolAmount).eq(new BN(prevPoolAmount))
                            ) {
                                matches.push({
                                    poolToken: position.poolToken,
                                    reserveToken: position.reserveToken
                                });
                            }
                        }

                        if (matches.length === 0) {
                            warning(
                                'Failed to fully match pool and reserve tokens. Trying to look for an updated position in the same block (assuming no more than a two updates in the same block)'
                            );

                            ids = await store.methods.protectedLiquidityIds(provider).call({}, blockNumber);
                            for (const id of ids) {
                                const position = await getPosition(id, blockNumber, store);
                                if (
                                    new BN(position.reserveAmount).eq(new BN(newReserveAmount)) &&
                                    new BN(position.poolAmount).eq(new BN(newPoolAmount))
                                ) {
                                    matches.push({
                                        poolToken: position.poolToken,
                                        reserveToken: position.reserveToken
                                    });
                                }
                            }

                            if (matches.length !== 1) {
                                error(
                                    'Failed to fully match pool and reserve tokens. Expected to find a single match, but found',
                                    arg('matches', matches.length)
                                );
                            }
                        } else if (matches.length !== 1) {
                            error(
                                'Failed to fully match pool and reserve tokens. Expected to find a single match, but found',
                                arg('matches', matches.length)
                            );
                        }

                        const { poolToken, reserveToken } = matches[0];

                        if (!strcmpi(POOL_TOKEN_ADDRESS, poolToken)) {
                            continue;
                        }

                        info(
                            'Found ProtectionUpdated event at block',
                            arg('blockNumber', blockNumber),
                            arg('provider', provider),
                            arg('prevPoolAmount', prevPoolAmount),
                            arg('newPoolAmount', newPoolAmount),
                            arg('prevReserveAmount', prevReserveAmount),
                            arg('newReserveAmount', newReserveAmount),
                            arg('timestamp', timestamp),
                            arg('tx', transactionHash)
                        );

                        const totalProviderAmount = get(providers, [provider, poolToken, reserveToken]) || 0;
                        set(
                            providers,
                            [provider, poolToken, reserveToken],
                            new BN(totalProviderAmount)
                                .add(new BN(newReserveAmount))
                                .sub(new BN(prevReserveAmount))
                                .toString()
                        );

                        eventCount++;

                        lastBlockNumber = blockNumber;

                        break;
                    }

                    case 'ProtectionRemoved': {
                        const provider = returnValues._provider;
                        const poolToken = returnValues._poolToken;
                        const reserveToken = returnValues._reserveToken;
                        const poolAmount = returnValues._poolAmount;
                        const reserveAmount = returnValues._reserveAmount;

                        if (!strcmpi(POOL_TOKEN_ADDRESS, poolToken)) {
                            continue;
                        }

                        info(
                            'Found ProtectionRemoved event at block',
                            arg('blockNumber', blockNumber),
                            arg('provider', provider),
                            arg('poolToken', poolToken),
                            arg('reserveToken', reserveToken),
                            arg('poolAmount', poolAmount),
                            arg('reserveAmount', reserveAmount),
                            arg('timestamp', timestamp),
                            arg('tx', transactionHash)
                        );

                        const totalProviderAmount = get(providers, [provider, poolToken, reserveToken]) || 0;
                        set(
                            totalProviderAmounts,
                            [provider, poolToken, reserveToken],
                            new BN(totalProviderAmount).sub(new BN(reserveAmount)).toString()
                        );

                        eventCount++;

                        lastBlockNumber = blockNumber;

                        break;
                    }
                }
            }
        }

        info('Finished processing all new protection change events', arg('count', eventCount));

        return { providers, lastBlockNumber };
    };

    const getStore = () => {
        const rawData = fs.readFileSync(path.join(ABI_DIR, LIQUIDITY_PROTECTION_STORE_ABI));
        const { abi } = JSON.parse(rawData);

        return new Contract(abi, LIQUIDITY_PROTECTION_STORE_ADDRESS);
    };

    const getProvider = () => {
        if (!PROVIDER_URL) {
            error('PROVIDER_URL is undefined');
        }

        const web3 = new Web3(PROVIDER_URL);
        Contract.setProvider(web3);

        return web3;
    };

    const getBlockRange = async (data, web3) => {
        let fromBlock;
        if (!data.lastBlockNumber) {
            warning('DB last block number is missing. Starting from the beginning');
            fromBlock = GENESIS_BLOCK_NUMBER;
        } else {
            fromBlock = data.lastBlockNumber + 1;
        }

        let toBlock = TARGET_BLOCK;
        if (!toBlock) {
            warning('TARGET_BLOCK is undefined. Targeting the latest block');

            toBlock = await web3.eth.getBlockNumber();
            if (toBlock === 0) {
                error('Node is out of sync. Please try again later');
            }
        }

        if (fromBlock > toBlock) {
            error('Invalid block range', arg('fromBlock', fromBlock), 'to', arg('toBlock', toBlock));
        }

        return { fromBlock, toBlock };
    };

    const loadData = async () => {
        await mkdirp(DB_DIR);

        let data = {};
        if (fs.existsSync(DB_PATH)) {
            const rawData = fs.readFileSync(DB_PATH);
            data = JSON.parse(rawData);
        }

        return data;
    };

    const saveData = async (data) => {
        fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
    };

    try {
        const web3 = getProvider();
        const store = getStore();

        const data = await loadData();
        const { fromBlock, toBlock } = await getBlockRange(data, web3);

        const newData = await getProtectionLiquidityChanges(data, fromBlock, toBlock, web3, store);

        await saveData(newData);

        process.exit(0);
    } catch (e) {
        error(e);

        process.exit(-1);
    }
};

main();
