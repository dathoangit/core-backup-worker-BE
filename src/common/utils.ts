import bcrypt from 'bcrypt';
import { type BigNumberish, ethers } from 'ethers';

/**
 * generate hash from password or string
 * @param {string} password
 * @returns {string}
 */
export function generateHash(password: string): string {
  return bcrypt.hashSync(password, 10);
}

/**
 * validate text with hash
 * @param {string} password
 * @param {string} hash
 * @returns {Promise<boolean>}
 */
export function validateHash(
  password: string | undefined,
  hash: string | undefined | null,
): Promise<boolean> {
  if (!password || !hash) {
    return Promise.resolve(false);
  }

  return bcrypt.compare(password, hash);
}

export function getVariableName<TResult>(
  getVar: () => TResult,
): string | undefined {
  const m = /\(\)=>(.*)/.exec(
    getVar.toString().replaceAll(/(\r\n|\n|\r|\s)/gm, ''),
  );

  if (!m) {
    throw new Error(
      "The function does not contain a statement matching 'return variableName;'",
    );
  }

  const fullMemberName = m[1];

  const memberParts = fullMemberName.split('.');

  return memberParts.at(-1);
}

export function expandDecimals(n: ethers.BigNumberish, decimals: number) {
  return ethers.BigNumber.from(n).mul(ethers.BigNumber.from(10).pow(decimals));
}

export function numberWithCommas(x: BigNumberish) {
  if (!x) {
    return '...';
  }

  const parts = x.toString().split('.');

  parts[0] = parts[0].replaceAll(/\B(?=(\d{3})+(?!\d))/g, ',');

  return parts.join('.');
}

export const padDecimals = (amount: BigNumberish, minDecimals: number) => {
  let amountStr = amount.toString();
  const dotIndex = amountStr.indexOf('.');

  if (dotIndex === -1) {
    amountStr = amountStr + '.0000';
  } else {
    const decimals = amountStr.length - dotIndex - 1;

    if (decimals < minDecimals) {
      amountStr = amountStr.padEnd(
        amountStr.length + (minDecimals - decimals),
        '0',
      );
    }
  }

  return amountStr;
};

export const limitDecimals = (amount: BigNumberish, maxDecimals?: number) => {
  let amountStr = amount.toString();

  if (maxDecimals === undefined) {
    return amountStr;
  }

  if (maxDecimals === 0) {
    return amountStr.split('.')[0];
  }

  const dotIndex = amountStr.indexOf('.');

  if (dotIndex !== -1) {
    const decimals = amountStr.length - dotIndex - 1;

    if (decimals > maxDecimals) {
      amountStr = amountStr.slice(
        0,
        Math.max(0, amountStr.length - (decimals - maxDecimals)),
      );
    }
  }

  return amountStr;
};

export const formatAmount = (
  amount: BigNumberish | undefined,
  tokenDecimals: number,
  displayDecimals?: number,
  useCommas?: boolean,
  defaultValue?: string,
) => {
  if (!defaultValue) {
    defaultValue = '...';
  }

  if (amount === undefined || amount.toString().length === 0) {
    return defaultValue;
  }

  if (displayDecimals === undefined) {
    displayDecimals = 4;
  }

  let amountStr = ethers.utils.formatUnits(amount, tokenDecimals);
  amountStr = limitDecimals(amountStr, displayDecimals);

  if (displayDecimals !== 0) {
    amountStr = padDecimals(amountStr, displayDecimals);
  }

  if (useCommas) {
    return numberWithCommas(amountStr);
  }

  return amountStr;
};

export const shortAddress = (account: string, decimals = 6) =>
  `${account.slice(0, decimals)}...${account.slice(-decimals)}`;
