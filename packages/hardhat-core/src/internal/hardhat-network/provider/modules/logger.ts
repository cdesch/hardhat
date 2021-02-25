import ansiEscapes from "ansi-escapes";
import chalk, { Chalk } from "chalk";
import { Transaction } from "ethereumjs-tx";
import { BN, bufferToHex, bufferToInt } from "ethereumjs-util";
import util from "util";

import { assertHardhatInvariant } from "../../../core/errors";
import { weiToHumanReadableString } from "../../../util/wei-values";
import {
  isCreateTrace,
  isPrecompileTrace,
  MessageTrace,
} from "../../stack-traces/message-trace";
import { ContractFunctionType } from "../../stack-traces/model";
import { SolidityError } from "../../stack-traces/solidity-errors";
import {
  FALLBACK_FUNCTION_NAME,
  RECEIVE_FUNCTION_NAME,
  UNRECOGNIZED_CONTRACT_NAME,
  UNRECOGNIZED_FUNCTION_NAME,
} from "../../stack-traces/solidity-stack-trace";
import {
  CallParams,
  GatherTracesResult,
  MineBlockResult,
  TransactionParams,
} from "../node-types";
import { Block } from "../types/Block";

interface FormatOptions {
  color?: Chalk;
  stopCollapsingMethod?: boolean;
  stopCollapsingMinedBlock?: boolean;
}

function printLine(line: string) {
  console.log(line);
}

function replaceLastLine(newLine: string) {
  process.stdout.write(
    // tslint:disable-next-line:prefer-template
    ansiEscapes.cursorHide +
      ansiEscapes.cursorPrevLine +
      newLine +
      "\n" +
      ansiEscapes.eraseEndLine +
      ansiEscapes.cursorShow
  );
}

export class ModulesLogger {
  private _logs: Array<string | [string, string]> = [];
  private _titleLength = 0;
  private _currentIndent = 0;
  private _emptyMinedBlocksRangeStart: number | undefined = undefined;
  private _methodBeingCollapsed?: string;
  private _methodCollapsedCount: number = 0;

  constructor(
    private _enabled: boolean,
    private _printLine = printLine,
    private _replaceLastLine = replaceLastLine
  ) {}

  public isEnabled() {
    return this._enabled;
  }

  public setEnabled(enabled: boolean) {
    this._enabled = enabled;
  }

  public log(message: string) {
    this._log(message);
  }

  public logBlock(
    result: MineBlockResult,
    codes: Buffer[],
    {
      printBlockNumber,
      printBlockHash,
      printTxBlockNumber,
      txHashToHighlight,
      startWithTxHash,
      indentAfterTransactionHash,
    }: {
      printBlockNumber: boolean;
      printBlockHash: boolean;
      printTxBlockNumber: boolean;
      txHashToHighlight?: Buffer;
      startWithTxHash: boolean;
      indentAfterTransactionHash: boolean;
    }
  ) {
    const { block, blockResult, traces } = result;
    const { results } = blockResult;

    assertHardhatInvariant(
      results.length === codes.length,
      "The array of codes should have the same length as the array of results"
    );

    this._indent(() => {
      if (printBlockNumber) {
        this.logBlockNumber(block);
      }
      if (printBlockHash) {
        this.logBlockHash(block);
      }

      this._indent(() => {
        for (let i = 0; i < block.transactions.length; i++) {
          const tx = block.transactions[i];
          const txGasUsed = results[i].gasUsed.toNumber();
          const txTrace = traces[i];
          const code = codes[i];

          const highlightTxHash =
            txHashToHighlight !== undefined &&
            tx.hash().equals(txHashToHighlight);

          this._logTxTrace(tx, txTrace, code, block, txGasUsed, {
            highlightTxHash,
            startWithTxHash,
            printTxBlockNumber,
            indentAfterTransactionHash,
          });

          this.logEmptyLineBetweenTransactions(i, block.transactions.length);
        }
      }, printBlockNumber || printBlockHash);
    });
  }

  public logSingleTransaction(
    tx: Transaction,
    block: Block,
    txGasUsed: number,
    txTrace: GatherTracesResult,
    code: Buffer
  ) {
    this._indent(() => {
      this._logTxTrace(tx, txTrace, code, block, txGasUsed, {
        highlightTxHash: false,
        startWithTxHash: false,
        printTxBlockNumber: true,
        indentAfterTransactionHash: false,
      });
    });
  }

  public logMinedBlock(result: MineBlockResult, codes: Buffer[]) {
    const { block, blockResult, traces } = result;
    const { results } = blockResult;

    assertHardhatInvariant(
      results.length === codes.length,
      "The array of codes should have the same length as the array of results"
    );

    const blockNumber = bufferToInt(result.block.header.number);
    const isEmpty = result.block.transactions.length === 0;

    this._indent(() => {
      this.logMinedBlockNumber(blockNumber, isEmpty);

      if (isEmpty) {
        return;
      }

      this._indent(() => {
        this.logBlockHash(block);

        this._indent(() => {
          for (let i = 0; i < block.transactions.length; i++) {
            const tx = block.transactions[i];
            const txGasUsed = results[i].gasUsed.toNumber();
            const txTrace = traces[i];
            const code = codes[i];

            this._logTxTrace(tx, txTrace, code, block, txGasUsed, {
              highlightTxHash: false,
              startWithTxHash: true,
              printTxBlockNumber: false,
              indentAfterTransactionHash: true,
            });

            this.logEmptyLineBetweenTransactions(i, block.transactions.length);
          }
        });
      });
    });
  }

  public logIntervalMinedBlock(result: MineBlockResult, codes: Buffer[]) {
    const { block, blockResult, traces } = result;
    const { results } = blockResult;

    assertHardhatInvariant(
      results.length === codes.length,
      "The array of codes should have the same length as the array of results"
    );

    this._indent(() => {
      this.logBlockHash(block);

      this._indent(() => {
        for (let i = 0; i < block.transactions.length; i++) {
          const tx = block.transactions[i];
          const txGasUsed = results[i].gasUsed.toNumber();
          const txTrace = traces[i];
          const code = codes[i];

          this._logTxTrace(tx, txTrace, code, block, txGasUsed, {
            highlightTxHash: false,
            startWithTxHash: true,
            printTxBlockNumber: false,
            indentAfterTransactionHash: true,
          });

          this.logEmptyLineBetweenTransactions(i, block.transactions.length);
        }
      });
    });
  }

  public logContractAndFunctionName(
    trace: MessageTrace | undefined,
    code: Buffer,
    {
      printNonContractCalled = false,
    }: { printNonContractCalled?: boolean } = {}
  ) {
    if (trace === undefined) {
      return;
    }

    if (isPrecompileTrace(trace)) {
      this.logWithTitle(
        "Precompile call",
        `<PrecompileContract ${trace.precompile}>`
      );
      return;
    }

    if (isCreateTrace(trace)) {
      if (trace.bytecode === undefined) {
        this.logWithTitle("Contract deployment", UNRECOGNIZED_CONTRACT_NAME);
      } else {
        this.logWithTitle("Contract deployment", trace.bytecode.contract.name);
      }

      if (trace.deployedContract !== undefined && trace.error === undefined) {
        this.logWithTitle(
          "Contract address",
          bufferToHex(trace.deployedContract)
        );
      }

      return;
    }

    if (code.length === 0) {
      if (printNonContractCalled) {
        this.log(`WARNING: Calling an account which is not a contract`);
      }

      return;
    }

    if (trace.bytecode === undefined) {
      this.logWithTitle("Contract call", UNRECOGNIZED_CONTRACT_NAME);
      return;
    }

    const func = trace.bytecode.contract.getFunctionFromSelector(
      trace.calldata.slice(0, 4)
    );

    const functionName: string =
      func === undefined
        ? UNRECOGNIZED_FUNCTION_NAME
        : func.type === ContractFunctionType.FALLBACK
        ? FALLBACK_FUNCTION_NAME
        : func.type === ContractFunctionType.RECEIVE
        ? RECEIVE_FUNCTION_NAME
        : func.name;

    this.logWithTitle(
      "Contract call",
      `${trace.bytecode.contract.name}#${functionName}`
    );
  }

  public logCurrentlySentTransaction(
    tx: Transaction,
    txGasUsed: number,
    txTrace: GatherTracesResult,
    code: Buffer,
    block: Block
  ) {
    this._indent(() => {
      this.log("Currently sent transaction:");
      this.logEmptyLine();

      this.logContractAndFunctionName(txTrace.trace, code);

      const txHash = bufferToHex(tx.hash());

      this.logWithTitle("Transaction", txHash);

      this.logTxFrom(tx.getSenderAddress());
      this.logTxTo(tx.to, txTrace.trace);
      this.logTxValue(new BN(tx.value));
      this.logWithTitle(
        "Gas used",
        `${txGasUsed} of ${bufferToInt(tx.gasLimit)}`
      );

      this.logWithTitle(
        `Block #${bufferToInt(block.header.number)}`,
        bufferToHex(block.hash())
      );

      this.logConsoleLogMessages(txTrace.consoleLogMessages);

      if (txTrace.error !== undefined) {
        this.logError(txTrace.error);
      }
    });
  }

  public logEmptyLineBetweenTransactions(
    currentIndex: number,
    totalTransactions: number
  ) {
    if (currentIndex + 1 < totalTransactions && totalTransactions > 1) {
      this.logEmptyLine();
    }
  }

  public logEstimateGasTrace(
    txParams: TransactionParams,
    code: Buffer,
    trace: MessageTrace | undefined,
    consoleLogMessages: string[],
    error: Error
  ) {
    this._indent(() => {
      this.logContractAndFunctionName(trace, code, {
        printNonContractCalled: true,
      });

      this.logTxFrom(txParams.from);
      this.logTxTo(txParams.to, trace);
      this.logTxValue(new BN(txParams.value));

      this.logConsoleLogMessages(consoleLogMessages);

      this.logError(error);
    });
  }

  public logCallTrace(
    callParams: CallParams,
    code: Buffer,
    trace: MessageTrace | undefined,
    consoleLogMessages: string[],
    error: Error | undefined
  ) {
    this._indent(() => {
      this.logContractAndFunctionName(trace, code, {
        printNonContractCalled: true,
      });

      this.logTxFrom(callParams.from);
      this.logTxTo(callParams.to, trace);
      if (callParams.value.gtn(0)) {
        this.logTxValue(callParams.value);
      }

      this.logConsoleLogMessages(consoleLogMessages);

      if (error !== undefined) {
        // TODO: If throwOnCallFailures is false, this will log the error, but the RPC method won't be red
        this.logError(error);
      }
    });
  }

  public logMinedBlockNumber(blockNumber: number, isEmpty: boolean) {
    this._log(`Mined ${isEmpty ? "empty " : ""}block #${blockNumber}`);
  }

  public logMultipleTransactionsWarning() {
    this._indent(() => {
      this._log(
        "There were other pending transactions mined in the same block:"
      );
    });
    this.logEmptyLine();
  }

  public logMultipleBlocksWarning() {
    this._indent(() => {
      this._log(
        "There were other pending transactions. More than one block had to be mined:"
      );
    });
    this.logEmptyLine();
  }

  public logTxTo(to: Buffer, trace?: MessageTrace) {
    if (trace !== undefined && isCreateTrace(trace)) {
      return;
    }

    this.logWithTitle("To", bufferToHex(to));
  }

  public logTxValue(value: BN) {
    this.logWithTitle("Value", weiToHumanReadableString(value));
  }

  public logTxFrom(from: Buffer) {
    this.logWithTitle("From", bufferToHex(from));
  }

  public logBlockNumber(block: Block) {
    this.log(
      `Block #${bufferToInt(block.header.number)}: ${bufferToHex(block.hash())}`
    );
  }

  public printMinedBlockNumber(blockNumber: number, isEmpty: boolean) {
    if (this._emptyMinedBlocksRangeStart !== undefined) {
      this._replaceLastLine(
        `Mined empty block range #${this._emptyMinedBlocksRangeStart} to #${blockNumber}`
      );
    } else {
      this._emptyMinedBlocksRangeStart = blockNumber;
      this._print(`Mined ${isEmpty ? "empty " : ""}block #${blockNumber}`, {
        stopCollapsingMinedBlock: false,
      });
    }
  }

  public logBlockHash(block: Block) {
    this.log(`Block: ${bufferToHex(block.hash())}`);
  }

  public logConsoleLogMessages(messages: string[]) {
    // This is a especial case, as we always want to print the console.log
    // messages. The difference is how.
    // If we have a logger, we should use that, so that logs are printed in
    // order. If we don't, we just print the messages here.
    if (!this._enabled) {
      for (const msg of messages) {
        this._printLine(msg);
      }
      return;
    }

    if (messages.length === 0) {
      return;
    }

    this.logEmptyLine();
    this.log("console.log:");

    for (const msg of messages) {
      this._log(`  ${msg}`);
    }
  }

  public logEmptyLine() {
    this._log("");
  }

  public logError(err: Error) {
    if (err instanceof SolidityError) {
      this.logEmptyLine();
      this._log(util.inspect(err));
    }
  }

  public logWithTitle(title: string, message: string) {
    title = this._indentSingleLine(title);

    // We always use the max title length we've seen. Otherwise the value move
    // a lot with each tx/call.
    if (title.length > this._titleLength) {
      this._titleLength = title.length;
    }

    this._logs.push([title, message]);
  }

  public debug(...args: any[]) {
    this.log(util.format(args[0], ...args.splice(1)));
  }

  public clearLogs() {
    this._logs = [];
  }

  public hasLogs(): boolean {
    return this._logs.length > 0;
  }

  public getLogs(): string[] {
    return this._logs.map((l) => {
      if (typeof l === "string") {
        return l;
      }

      const title = `${l[0]}:`;

      return `${title.padEnd(this._titleLength + 1)} ${l[1]}`;
    });
  }

  public printError(err: Error) {
    if (err instanceof SolidityError) {
      this.printEmptyLine();
      this._indent(() => {
        this._print(util.inspect(err));
      });
    }
  }

  public printErrorMessage(errorMessage: string) {
    this._indent(() => {
      this._print(errorMessage);
    });
  }

  public printFailedMethod(method: string) {
    this._print(method, { color: chalk.red });
  }

  public printLogs(): boolean {
    const logs = this.getLogs();
    if (logs.length === 0) {
      return false;
    }

    for (const msg of logs) {
      this._print(msg);
    }

    this.clearLogs();

    return true;
  }

  public printMetaMaskWarning() {
    const message =
      "If you are using MetaMask, you can learn how to fix this error here: https://hardhat.org/metamask-issue";

    this._indent(() => {
      this._print(message, { color: chalk.yellow });
    });
  }

  public printMethod(method: string) {
    if (this._shouldCollapseMethod(method)) {
      this._methodCollapsedCount += 1;

      this._replaceLastLine(
        chalk.green(`${method} (${this._methodCollapsedCount})`)
      );
    } else {
      this._startCollapsingMethod(method);
      this._print(method, { color: chalk.green, stopCollapsingMethod: false });
    }
  }

  public printMethodNotSupported(method: string) {
    this._print(`${method} - Method not supported`, { color: chalk.red });
  }

  public printEmptyLine() {
    this._print("");
  }

  public printUnknownError(err: Error) {
    this.printError(err);
    this.printEmptyLine();
    this._indent(() => {
      this._print(
        "If you think this is a bug in Hardhat, please report it here: https://hardhat.org/reportbug"
      );
    });
  }

  private _format(msg: string, { color }: FormatOptions = {}): string {
    if (msg === "") {
      // don't indent empty lines
      return msg;
    }

    if (this._currentIndent > 0) {
      msg = msg
        .split("\n")
        .map((line) => " ".repeat(this._currentIndent) + line)
        .join("\n");
    }

    if (color !== undefined) {
      return color(msg);
    }

    return msg;
  }

  private _indent<T>(cb: () => T, enabled = true) {
    if (enabled) {
      this._currentIndent += 2;
    }
    try {
      return cb();
    } finally {
      if (enabled) {
        this._currentIndent -= 2;
      }
    }
  }

  private _indentSingleLine(message: string): string {
    return " ".repeat(this._currentIndent) + message;
  }

  private _log(msg: string, formatOptions: FormatOptions = {}) {
    if (formatOptions.stopCollapsingMethod !== false) {
      this._stopCollapsingMethod();
    }
    if (formatOptions.stopCollapsingMinedBlock !== false) {
      this._emptyMinedBlocksRangeStart = undefined;
    }
    const formattedMessage = this._format(msg, formatOptions);

    this._logs.push(formattedMessage);
  }

  private _logTxTrace(
    tx: Transaction,
    txTrace: GatherTracesResult,
    code: Buffer,
    block: Block,
    txGasUsed: number,
    {
      highlightTxHash,
      startWithTxHash,
      printTxBlockNumber,
      indentAfterTransactionHash,
    }: {
      highlightTxHash: boolean;
      startWithTxHash: boolean;
      printTxBlockNumber: boolean;
      indentAfterTransactionHash: boolean;
    }
  ) {
    if (!startWithTxHash) {
      this.logContractAndFunctionName(txTrace.trace, code);
    }

    let txHash = bufferToHex(tx.hash());

    if (highlightTxHash) {
      txHash = chalk.bold(txHash);
    }

    this.logWithTitle("Transaction", txHash);

    this._indent(() => {
      if (startWithTxHash) {
        this.logContractAndFunctionName(txTrace.trace, code);
      }
      this.logTxFrom(tx.getSenderAddress());
      this.logTxTo(tx.to, txTrace.trace);
      this.logTxValue(new BN(tx.value));
      this.logWithTitle(
        "Gas used",
        `${txGasUsed} of ${bufferToInt(tx.gasLimit)}`
      );

      if (printTxBlockNumber) {
        this.logWithTitle(
          `Block #${bufferToInt(block.header.number)}`,
          bufferToHex(block.hash())
        );
      }

      this.logConsoleLogMessages(txTrace.consoleLogMessages);

      if (txTrace.error !== undefined) {
        this.logError(txTrace.error);
      }
    }, indentAfterTransactionHash);
  }

  private _print(msg: string, formatOptions: FormatOptions = {}) {
    if (formatOptions.stopCollapsingMethod !== false) {
      this._stopCollapsingMethod();
    }
    if (formatOptions.stopCollapsingMinedBlock !== false) {
      this._emptyMinedBlocksRangeStart = undefined;
    }
    const formattedMessage = this._format(msg, formatOptions);

    this._printLine(formattedMessage);
  }

  private _shouldCollapseMethod(method: string) {
    return (
      method === this._methodBeingCollapsed &&
      !this.hasLogs() &&
      this._methodCollapsedCount > 0
    );
  }

  private _startCollapsingMethod(method: string) {
    this._methodBeingCollapsed = method;
    this._methodCollapsedCount = 1;
  }

  private _stopCollapsingMethod() {
    this._methodBeingCollapsed = undefined;
    this._methodCollapsedCount = 0;
  }
}
