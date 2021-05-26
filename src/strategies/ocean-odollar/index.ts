import { getAddress } from '@ethersproject/address';
import { subgraphRequest } from '../../utils';
import { formatUnits, parseUnits } from '@ethersproject/units';
import { BigNumber } from '@ethersproject/bignumber';
import { verifyResultsLength, verifyResults } from './oceanUtils';

export const author = 'w1kke';
export const version = '0.1.0';

const OCEAN_ERC20_DECIMALS = 18;
const UMA_SUBGRAPH_URL = {
  '1':
    'https://api.thegraph.com/subgraphs/name/umaprotocol/mainnet-contracts'
};

// Returns a BigDecimal as a BigNumber with 10^decimals extra zeros
export function bdToBn(bd, decimals) {
  let bn;
  const splitDecimal = bd.split('.');

  if (splitDecimal.length > 1) {
    bn = `${splitDecimal[0]}.${splitDecimal[1].slice(
      0,
      decimals - splitDecimal[0].length - 1
    )}`;
  } else {
    bn = `${splitDecimal[0]}`;
  }

  const bn2 = parseUnits(bn, decimals);
  return bn2;
}

function bn(num: any): BigNumber {
  return BigNumber.from(num.toString());
}

export async function strategy(
  space,
  network,
  provider,
  addresses,
  options,
  snapshot
) {
  console.log("Hi");
  const params = {
    financialContracts:    
      {
        __args: {
          where: {
            id: "0x312ecf2854f73a3ff616e3cdbc05e2ff6a98d1f0"
          }
        },
        positions: {
          id: true,
          contract: {
            id: true
          },
          sponsor: {
            id: true,
            positions: {
              id: true,
              collateral: true,
              rawCollateral: true
            },
            liquidations: {
              id: true,
              lockedCollateral: true
            },
          },
          collateralToken: {
            id: true,
            name: true
          }
        }
      }
  };
  console.log("Hi");

  // Retrieve the top 1000 pools
  const graphResults = await subgraphRequest(
    UMA_SUBGRAPH_URL[network],
    params
  );

  console.log(graphResults);
  var ocean_locked = 0;
  var ocean_liquidated = 0;
  graphResults.financialContracts.forEach((contract) => {
    contract.positions.map((position) => {
      position.sponsor.positions.map((pos) => {
        console.log(pos);
        ocean_locked += +pos.collateral;
      })
      position.sponsor.liquidations.map((liq) => {
        console.log(liq);
        ocean_liquidated += +liq.lockedCollateral;
      })
    })
  })

  console.log("sum ocean locked");
  console.log(ocean_locked);
  console.log("sum ocean liquidated");
  console.log(ocean_liquidated);
  console.log("resulting ocean in contract");
  console.log(ocean_locked - ocean_liquidated);

  // Get total votes, for ALL addresses, inside top 1000 pools, with a minimum of 0.0001 shares
  const score = {};
  const userAddresses: string[] = [];
  const return_score = {};
  if (graphResults && graphResults.pools) {
    graphResults.pools.forEach((pool) => {
      if (pool.holderCount > 0 && pool.active) {
        pool.shares.map((share) => {
          const userAddress = getAddress(share.userAddress.id);
          if (!userAddresses.includes(userAddress))
            userAddresses.push(userAddress);
          if (!score[userAddress]) score[userAddress] = BigNumber.from(0);
          let userShare =
            share.balance * (pool.oceanReserve / pool.totalShares);
          if (userShare > 0.0001) {
            score[userAddress] = score[userAddress].add(
              bdToBn(userShare.toString(), OCEAN_ERC20_DECIMALS)
            );
          }
        });
      }
    });

    // We then sum total votes, per user address
    userAddresses.forEach((address) => {
      let parsedSum = parseFloat(
        formatUnits(score[address], OCEAN_ERC20_DECIMALS)
      );
      return_score[address] = parsedSum;
    });
  }

  // We then filter only the addresses expected
  const results = Object.fromEntries(
    Object.entries(return_score).filter(([k, v]) => addresses.indexOf(k) >= 0)
  );

  // Test validation: Update examples.json w/ expectedResults to reflect LPs @ blockHeight
  // Success criteria: Address scores and length, must match expectedResults. Order not validated.
  // From GRT's graphUtils.ts => verifyResults => Scores need to match expectedResults.
  // npm run test --strategy=ocean-marketplace | grep -E 'SUCCESS|ERROR'
  if (options.expectedResults) {
    let expectedResults = {};
    Object.keys(options.expectedResults.scores).forEach(function (key) {
      expectedResults[key] = results[key];
    });

    verifyResults(
      JSON.stringify(expectedResults),
      JSON.stringify(options.expectedResults.scores),
      'Scores'
    );

    verifyResultsLength(
      Object.keys(expectedResults).length,
      Object.keys(options.expectedResults.scores).length,
      'Scores'
    );
  }

  return results || {};
}
