import * as t from "io-ts";

import { optional } from "../../../../util/io-ts";
import { rpcHash } from "../base-types";

import { optionalRpcOldBlockTag } from "./blockTag";
import { optionalRpcLogAddress } from "./logAddress";
import { optionalRpcLogTopics } from "./logTopics";

export const rpcFilterRequest = t.type(
  {
    fromBlock: optionalRpcOldBlockTag,
    toBlock: optionalRpcOldBlockTag,
    address: optionalRpcLogAddress,
    topics: optionalRpcLogTopics,
    blockHash: optional(rpcHash),
  },
  "RpcFilterRequest"
);

export type RpcFilterRequest = t.TypeOf<typeof rpcFilterRequest>;

export const optionalRpcFilterRequest = optional(rpcFilterRequest);

export type OptionalRpcFilterRequest = t.TypeOf<
  typeof optionalRpcFilterRequest
>;
