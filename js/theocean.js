'use strict';

const Exchange = require ('./base/Exchange');
const { ExchangeError, AuthenticationError } = require ('./base/errors');
const { ROUND } = require ('./base/functions/number');
const log = require ('ololog').unlimited;
const { ZeroEx } = require ('0x.js')
const ethAbi = require ('ethereumjs-abi')
const ethUtil = require ('ethereumjs-util')
var BN = require("bn.js");


module.exports = class theocean extends Exchange {
    describe () {
        return this.deepExtend (super.describe (), {
            'id': 'theocean',
            'name': 'TheOcean',
            'countries': [ 'US' ],
            'rateLimit': 3000,
            'version': 'v0',
            'userAgent': this.userAgents['chrome'],
            'parseJsonResponse': false,
            // add GET https://api.staging.theocean.trade/api/v0/candlesticks/intervals to fetchMarkets
            'timeframes': {
                '5m': '300',
                '15m': '900',
                '1h': '3600',
                '6h': '21600',
                '1d': '86400',
            },
            'has': {
                'CORS': false, // ?
                'fetchTickers': true,
                'fetchOHLCV': false,
                'fetchOrder': true,
            },
            'urls': {
                'logo': 'https://user-images.githubusercontent.com/1294454/27982022-75aea828-63a0-11e7-9511-ca584a8edd74.jpg',
                'api': 'https://api.staging.theocean.trade/api',
                'www': 'https://theocean.trade',
                'doc': 'https://docs.theocean.trade',
                'fees': 'https://theocean.trade/fees',
            },
            'api': {
                'public': {
                    'get': [
                        'token_pairs',
                        'ticker',
                        'tickers',
                        'candlesticks',
                        'candlesticks/intervals',
                        'trade_history',
                        'order_book',
                        'order/{orderHash}',
                    ],
                },
                'private': {
                    'get': [
                        'available_balance',
                        'user_history',
                    ],
                    'post': [
                        'limit_order/reserve',
                        'limit_order/place',
                        'market_order/reserve',
                        'market_order/place',
                    ],
                    'delete': [
                        'order/{orderHash}',
                    ],
                },
            },
            'exceptions': {
                "Schema validation failed for 'query'": ExchangeError, // { "message": "Schema validation failed for 'query'", "errors": ... }
                "Logic validation failed for 'query'": ExchangeError, // { "message": "Logic validation failed for 'query'", "errors": ... }
                "Schema validation failed for 'body'": ExchangeError, // { "message": "Schema validation failed for 'body'", "errors": ... }
                "Logic validation failed for 'body'": ExchangeError, // { "message": "Logic validation failed for 'body'", "errors": ... }
            },
        });
    }

    calculateFee (symbol, type, side, amount, price, takerOrMaker = 'taker', params = {}) {
        let market = this.markets[symbol];
        let key = 'quote';
        let rate = market[takerOrMaker];
        let cost = parseFloat (this.costToPrecision (symbol, amount * rate));
        if (side === 'sell') {
            cost *= price;
        } else {
            key = 'base';
        }
        return {
            'type': takerOrMaker,
            'currency': market[key],
            'rate': rate,
            'cost': cost,
        };
    }

    async fetchMarkets () {
        let markets = await this.publicGetTokenPairs ();
        //
        //     [
        //       {
        //         "baseToken": {
        //           "address": "0xa8e9fa8f91e5ae138c74648c9c304f1c75003a8d",
        //           "symbol": "ZRX",
        //           "decimals": "18",
        //           "minAmount": "1000000000000000000",
        //           "maxAmount": "100000000000000000000000",
        //           "precision": "18"
        //         },
        //         "quoteToken": {
        //           "address": "0xc00fd9820cd2898cc4c054b7bf142de637ad129a",
        //           "symbol": "WETH",
        //           "decimals": "18",
        //           "minAmount": "5000000000000000",
        //           "maxAmount": "100000000000000000000",
        //           "precision": "18"
        //         }
        //       }
        //     ]
        //
        let result = [];
        for (let i = 0; i < markets.length; i++) {
            let market = markets[i];
            let baseToken = market['baseToken'];
            let quoteToken = market['quoteToken'];
            let baseId = baseToken['address'];
            let quoteId = quoteToken['address'];
            let base = baseToken['symbol'];
            let quote = quoteToken['symbol'];
            base = this.commonCurrencyCode (base);
            quote = this.commonCurrencyCode (quote);
            let symbol = base + '/' + quote;
            let id = baseId + '/' + quoteId;
            let precision = {
                'amount': this.safeInteger (baseToken, 'decimals'),
                'price': this.safeInteger (quoteToken, 'decimals'),
            };
            let amountLimits = {
                'min': this.fromWei (this.safeString (baseToken, 'minAmount')),
                'max': this.fromWei (this.safeString (baseToken, 'maxAmount')),
            };
            let priceLimits = {
                'min': undefined,
                'max': undefined,
            };
            let costLimits = {
                'min': this.fromWei (this.safeString (quoteToken, 'minAmount')),
                'max': this.fromWei (this.safeString (quoteToken, 'maxAmount')),
            };
            let limits = {
                'amount': amountLimits,
                'price': priceLimits,
                'cost': costLimits,
            };
            let active = true;
            result.push ({
                'id': id,
                'symbol': symbol,
                'base': base,
                'quote': quote,
                'baseId': baseId,
                'quoteId': quoteId,
                'active': active,
                'taker': undefined,
                'maker': undefined,
                'precision': precision,
                'limits': limits,
                'info': market,
            });
        }
        return result;
    }

    parseOHLCV (ohlcv, market = undefined, timeframe = '5m', since = undefined, limit = undefined) {
        return [
            this.safeInteger (ohlcv, 'startTime') * 1000,
            this.safeFloat (ohlcv, 'open'),
            this.safeFloat (ohlcv, 'high'),
            this.safeFloat (ohlcv, 'low'),
            this.safeFloat (ohlcv, 'close'),
            this.fromWei (this.safeString (ohlcv, 'baseVolume')),
            // this.safeString (ohlcv, 'quoteVolume'),
        ];
    }

    async fetchOHLCV (symbol, timeframe = '5m', since = undefined, limit = undefined, params = {}) {
        await this.loadMarkets ();
        let market = this.market (symbol);
        let request = {
            'baseTokenAddress': market['baseId'],
            'quoteTokenAddress': market['quoteId'],
            'interval': this.timeframes[timeframe],
            // 'endTime': endTime, // (optional) Snapshot end time
        };
        if (typeof since === 'undefined') {
            throw new ExchangeError (this.id + ' fetchOHLCV requires a since argument');
        }
        request['startTime'] = parseInt (since / 1000);
        let response = await this.publicGetCandlesticks (this.extend (request, params));
        //
        //   [
        //     {
        //         "high": "100.52",
        //         "low": "97.23",
        //         "open": "98.45",
        //         "close": "99.23",
        //         "baseVolume": "2400000000000000000000",
        //         "quoteVolume": "1200000000000000000000",
        //         "startTime": "1512929323784"
        //     },
        //     {
        //         "high": "100.52",
        //         "low": "97.23",
        //         "open": "98.45",
        //         "close": "99.23",
        //         "volume": "2400000000000000000000",
        //         "startTime": "1512929198980"
        //     }
        //   ]
        //
        return this.parseOHLCVs (response, market, timeframe, since, limit);
    }

    async fetchBalanceByCode (code, params = {}) {
        await this.loadMarkets ();
        let currency = this.currency (code);
        let request = {
            'walletAddress': this.uid.toLowerCase (),
            'tokenAddress': currency['id'],
        };
        let response = await this.privateGetAvailableBalance (this.extend (request, params));
        //
        //     {
        //       "availableBalance": "1001006594219628829207"
        //     }
        //
        let balance = this.fromWei (this.safeString (response, 'availableBalance'));
        return {
            'free': balance,
            'used': 0,
            'total': balance,
        };
    }

    async fetchBalance (params = {}) {
        await this.loadMarkets ();
        const codes = this.safeValue (params, 'codes');
        if ((typeof codes === 'undefined') || (!Array.isArray (codes))) {
            throw new ExchangeError (this.id + ' fetchBalance requires a `codes` parameter (an array of currency codes)');
        }
        let result = {};
        for (let i = 0; i < codes.length; i++) {
            const code = codes[i];
            result[code] = await this.fetchBalanceByCode (code);
        }
        return this.parseBalance (result);
    }

    parseBidAsk (bidask, priceKey = 0, amountKey = 1) {
        let price = parseFloat (bidask[priceKey]);
        let amount = this.fromWei (bidask[amountKey]);
        return [ price, amount, bidask ];
    }

    async fetchOrderBook (symbol, limit = undefined, params = {}) {
        await this.loadMarkets ();
        let market = this.market (symbol);
        let request = {
            'baseTokenAddress': market['baseId'],
            'quoteTokenAddress': market['quoteId'],
        };
        if (typeof limit !== 'undefined') {
            request['depth'] = limit;
        }
        let response = await this.publicGetOrderBook (this.extend (request, params));
        //
        //     {
        //       "bids": [
        //         {
        //           "orderHash": "0x94629386298dee69ae63cd3e414336ae153b3f02cffb9ffc53ad71e166615618",
        //           "price": "0.00050915",
        //           "availableAmount": "100000000000000000000",
        //           "creationTimestamp": "1512929327792",
        //           "expirationTimestampInSec": "525600"
        //         }
        //       ],
        //       "asks": [
        //         {
        //           "orderHash": "0x94629386298dee69ae63cd3e414336ae153b3f02cffb9ffc53ad71e166615618",
        //           "price": "0.00054134",
        //           "availableAmount": "100000000000000000000",
        //           "creationTimestamp": "1512929323784",
        //           "expirationTimestampInSec": "525600"
        //         }
        //       ]
        //     }
        //
        return this.parseOrderBook (response, undefined, 'bids', 'asks', 'price', 'availableAmount');
    }

    parseTicker (ticker, market = undefined) {
        //
        //     {
        //         "bid": "0.00050915",
        //         "ask": "0.00054134",
        //         "last": "0.00052718",
        //         "volume": "3000000000000000000",
        //         "timestamp": "1512929327792"
        //     }
        //
        let timestamp = parseInt (this.safeFloat (ticker, 'timestamp') / 1000);
        let symbol = undefined;
        if (typeof market !== 'undefined') {
            symbol = market['symbol'];
        }
        let last = this.safeFloat (ticker, 'last');
        return {
            'symbol': symbol,
            'timestamp': timestamp,
            'datetime': this.iso8601 (timestamp),
            'high': undefined,
            'low': undefined,
            'bid': this.safeFloat (ticker, 'bid'),
            'bidVolume': undefined,
            'ask': this.safeFloat (ticker, 'ask'),
            'askVolume': undefined,
            'vwap': undefined,
            'open': undefined,
            'close': last,
            'last': last,
            'previousClose': undefined,
            'change': this.fromWei (this.safeFloat (ticker, 'priceChange')),
            'percentage': undefined,
            'average': undefined,
            'baseVolume': this.fromWei (this.safeString (ticker, 'volume')),
            'quoteVolume': undefined,
            'info': ticker,
        };
    }

    async fetchTickers (symbols = undefined, params = {}) {
        await this.loadMarkets ();
        let tickers = await this.publicGetTickers (params);
        //
        //     [{
        //     "baseTokenAddress": "0xa8e9fa8f91e5ae138c74648c9c304f1c75003a8d",
        //     "quoteTokenAddress": "0xc00fd9820cd2898cc4c054b7bf142de637ad129a",
        //     "ticker": {
        //         "bid": "0.00050915",
        //         "ask": "0.00054134",
        //         "last": "0.00052718",
        //         "volume": "3000000000000000000",
        //         "timestamp": "1512929327792"
        //     }
        //     }]
        //
        let result = {};
        for (let i = 0; i < tickers.length; i++) {
            let ticker = tickers[i];
            let baseId = this.safeString (ticker, 'baseTokenAddress');
            let quoteId = this.safeString (ticker, 'quoteTokenAddress');
            let marketId = baseId + '/' + quoteId;
            let market = undefined;
            let symbol = marketId;
            if (marketId in this.markets_by_id) {
                market = this.markets_by_id[marketId];
                symbol = market['symbol'];
            }
            result[symbol] = this.parseTicker (ticker['ticker'], market);
        }
        return result;
    }

    async fetchTicker (symbol, params = {}) {
        await this.loadMarkets ();
        let market = this.market (symbol);
        let request = {
            'baseTokenAddress': market['baseId'],
            'quoteTokenAddress': market['quoteId'],
        };
        let response = await this.publicGetTicker (this.extend (request, params));
        return this.parseTicker (response, market);
    }

    parseTrade (trade, market = undefined) {
        //
        //     {
        //         "id": "37212",
        //         "transactionHash": "0x5e6e75e1aa681b51b034296f62ac19be7460411a2ad94042dd8ba637e13eac0c",
        //         "amount": "300000000000000000",
        //         "price": "0.00052718",
        // ------- they also have a "confirmed" status here ↓ -----------------
        //         "status": "filled", // filled | settled | failed
        //         "lastUpdated": "1520265048996"
        //     }
        //
        let timestamp = parseInt (trade['lastUpdated']) * 1000;
        let price = this.safeFloat (trade, 'price');
        let orderId = this.safeString (trade, 'transactionHash');
        let id = this.safeString (trade, 'id');
        let symbol = undefined;
        if (typeof market !== 'undefined') {
            symbol = market['symbol'];
        }
        let amount = this.fromWei (this.safeString (trade, 'amount'));
        let cost = undefined;
        if (typeof amount !== 'undefined') {
            if (typeof price !== 'undefined') {
                cost = amount * price;
            }
        }
        let takerOrMaker = 'taker';
        let fee = undefined;
        // let fee = this.calculateFee (symbol, type, side, amount, price, takerOrMaker);
        return {
            'id': id,
            'order': orderId,
            'timestamp': timestamp,
            'datetime': this.iso8601 (timestamp),
            'symbol': symbol,
            'type': undefined,
            'side': undefined,
            'takerOrMaker': takerOrMaker,
            'price': price,
            'amount': amount,
            'cost': cost,
            'fee': fee,
            'info': trade,
        };
    }

    async fetchTrades (symbol, since = undefined, limit = undefined, params = {}) {
        await this.loadMarkets ();
        let market = this.market (symbol);
        let request = {
            'baseTokenAddress': market['baseId'],
            'quoteTokenAddress': market['quoteId'],
        };
        let response = await this.publicGetTradeHistory (this.extend (request, params));
        //
        //     [
        //       {
        //         "id": "37212",
        //         "transactionHash": "0x5e6e75e1aa681b51b034296f62ac19be7460411a2ad94042dd8ba637e13eac0c",
        //         "amount": "300000000000000000",
        //         "price": "0.00052718",
        //         "status": "filled", // filled | settled | failed
        //         "lastUpdated": "1520265048996"
        //       }
        //     ]
        //
        return this.parseTrades (response, market, since, limit);
    }

    priceToPrecision (symbol, price) {
        return this.decimalToPrecision (price, ROUND, this.markets[symbol]['precision']['price'], this.precisionMode);
    }

    getOrderHash (contractAddress, tokenGet, amountGet, tokenGive, amountGive, expires, orderNonce) {
        let unpacked = [ contractAddress, tokenGet, amountGet, tokenGive, amountGive, expires, orderNonce ];
        let types = [ 'address', 'address', 'uint256', 'address', 'uint256', 'uint256', 'uint256' ];
        const sha256 = ethAbi.soliditySHA256 (types, unpacked);
        const sha256Hex = sha256.toString ('hex');
        const hash = '0x' + sha256Hex;
        return hash
    }

    // getOrderHashHex (order) {
    //     var orderParts = [
    //         { value: order.exchangeContractAddress, type: types_1.SolidityTypes.Address },
    //         { value: order.maker, type: types_1.SolidityTypes.Address },
    //         { value: order.taker, type: types_1.SolidityTypes.Address },
    //         { value: order.makerTokenAddress, type: types_1.SolidityTypes.Address },
    //         { value: order.takerTokenAddress, type: types_1.SolidityTypes.Address },
    //         { value: order.feeRecipient, type: types_1.SolidityTypes.Address },
    //         { value: bigNumberToBN(order.makerTokenAmount), type: types_1.SolidityTypes.Uint256, },
    //         { value: bigNumberToBN(order.takerTokenAmount), type: types_1.SolidityTypes.Uint256, },
    //         { value: bigNumberToBN(order.makerFee), type: types_1.SolidityTypes.Uint256, },
    //         { value: bigNumberToBN(order.takerFee), type: types_1.SolidityTypes.Uint256, },
    //         { value: bigNumberToBN(order.expirationUnixTimestampSec), type: types_1.SolidityTypes.Uint256, },
    //         { value: bigNumberToBN(order.salt), type: types_1.SolidityTypes.Uint256 },
    //     ];
    //     var types = _.map(orderParts, function (o) { return o.type; });
    //     var values = _.map(orderParts, function (o) { return o.value; });
    //     var hashBuff = ethABI.soliditySHA3(types, values);
    //     var hashHex = ethUtil.bufferToHex(hashBuff);
    //     return hashHex;
    // }

    signOrder (order, account = undefined) {
        const orderHash = ZeroEx.getOrderHashHex (order);
        log.red ('orderHash:', orderHash)
        let unpacked = [
            order['exchangeContractAddress'], // { value: order.exchangeContractAddress, type: types_1.SolidityTypes.Address },
            order['maker'], // { value: order.maker, type: types_1.SolidityTypes.Address },
            order['taker'], // { value: order.taker, type: types_1.SolidityTypes.Address },
            order['makerTokenAddress'], // { value: order.makerTokenAddress, type: types_1.SolidityTypes.Address },
            order['takerTokenAddress'], // { value: order.takerTokenAddress, type: types_1.SolidityTypes.Address },
            order['feeRecipient'], // { value: order.feeRecipient, type: types_1.SolidityTypes.Address },
            new BN(order['makerTokenAmount'], 10), // { value: bigNumberToBN(order.makerTokenAmount), type: types_1.SolidityTypes.Uint256, },
            new BN(order['takerTokenAmount'], 10), // { value: bigNumberToBN(order.takerTokenAmount), type: types_1.SolidityTypes.Uint256, },
            new BN(order['makerFee'], 10), // { value: bigNumberToBN(order.makerFee), type: types_1.SolidityTypes.Uint256, },
            new BN(order['takerFee'], 10), // { value: bigNumberToBN(order.takerFee), type: types_1.SolidityTypes.Uint256, },
            new BN(order['expirationUnixTimestampSec'], 10), // { value: bigNumberToBN(order.expirationUnixTimestampSec), type: types_1.SolidityTypes.Uint256, },
            new BN(order['salt'], 10), // 'uint256', // { value: bigNumberToBN(order.salt), type: types_1.SolidityTypes.Uint256 },
            // contractAddress, tokenGet, amountGet, tokenGive, amountGive, expires, orderNonce ];
        ];
        let types = [
            'address', // { value: order.exchangeContractAddress, type: types_1.SolidityTypes.Address },
            'address', // { value: order.maker, type: types_1.SolidityTypes.Address },
            'address', // { value: order.taker, type: types_1.SolidityTypes.Address },
            'address', // { value: order.makerTokenAddress, type: types_1.SolidityTypes.Address },
            'address', // { value: order.takerTokenAddress, type: types_1.SolidityTypes.Address },
            'address', // { value: order.feeRecipient, type: types_1.SolidityTypes.Address },
            'uint256', // { value: bigNumberToBN(order.makerTokenAmount), type: types_1.SolidityTypes.Uint256, },
            'uint256', // { value: bigNumberToBN(order.takerTokenAmount), type: types_1.SolidityTypes.Uint256, },
            'uint256', // { value: bigNumberToBN(order.makerFee), type: types_1.SolidityTypes.Uint256, },
            'uint256', // { value: bigNumberToBN(order.takerFee), type: types_1.SolidityTypes.Uint256, },
            'uint256', // { value: bigNumberToBN(order.expirationUnixTimestampSec), type: types_1.SolidityTypes.Uint256, },
            'uint256', // { value: bigNumberToBN(order.salt), type: types_1.SolidityTypes.Uint256 },
        ];
        // log.bright.blue (types)
        log.bright.blue (unpacked)
        const sha256 = ethAbi.soliditySHA3 (types, unpacked);
        const sha256Hex = sha256.toString ('hex');
        const hash = '0x' + sha256Hex;
        log.red ('orderHas2:', hash)

        let acc = this.decryptAccountFromPrivateKey (this.privateKey)

        const signature = acc.sign (hash, this.privateKey.slice (2));
        const sig2 = ethUtil.ecsign (new Buffer(signature.messageHash.slice (2), 'hex'), new Buffer(this.privateKey.slice (2), 'hex'));
        const sig3 = ethUtil.ecsign (new Buffer(hash.slice (2), 'hex'), new Buffer(this.privateKey.slice (2), 'hex'));
        log.red (signature)
        log.green ('----------------------------------------------------------')
        log.red (sig2.v.toString (16))
        log.red ({
            v: '0x' + sig2.v.toString (16),
            r: '0x' + sig2.r.toString ('hex'),
            s: '0x' + sig2.s.toString ('hex'),
        })
        log.magenta ({
            v: '0x' + sig3.v.toString (16),
            r: '0x' + sig3.r.toString ('hex'),
            s: '0x' + sig3.s.toString ('hex'),
        })
        process.exit ();
        // const signature = await this.zeroEx.signOrderHashAsync (orderHash, signerAddress)
        // return this.extend (order, {
        //     'orderHash': orderHash,
        //     'ecSignature': signature
        // });
        process.exit ()
    }

    async createOrder (symbol, type, side, amount, price = undefined, params = {}) {
        await this.loadMarkets ();
        let market = this.market (symbol);
        let reserveRequest = {
            'walletAddress': this.uid.toLowerCase (), // Your Wallet Address
            'baseTokenAddress': market['baseId'], // Base token address
            'quoteTokenAddress': market['quoteId'], // Quote token address
            'side': side, // "buy" or "sell"
            'orderAmount': this.toWei (this.amountToPrecision (symbol, amount)), // Base token amount in wei
            'feeOption': 'feeInNative', // Fees can be paid in native currency ("feeInNative"), or ZRX ("feeInZRX")
        };
        if (type === 'limit') {
            reserveRequest['price'] = this.priceToPrecision (symbol, price); // Price denominated in quote tokens (limit orders only)
        }
        let method = 'privatePost' + this.capitalize (type) + 'Order';
        let reserveMethod = method + 'Reserve';
        log.green (reserveRequest);
        // process.exit ();
        // let reserveResponse = await this[reserveMethod] (this.extend (reserveRequest, params));
        //
        // ---- market orders -------------------------------------------------
        //
        let reserveResponse =
            {       matchingOrderID:   "MARKET_INTENT:8yjjtgkt6k8yjjtgkt6ljjtgkt6m",
              unsignedMatchingOrder: {                      maker: "",
                                                            taker: "0x00ba938cc0df182c25108d7bf2ee3d37bce07513",
                                                makerTokenAddress: "0xd0a1e359811322d97991e03f863a0c30c2cf029c",
                                                takerTokenAddress: "0x6ff6c0ff1d68b964901f986d4c9fa3ac68346570",
                                                 makerTokenAmount: "27100000000000000",
                                                 takerTokenAmount: "881877819717396973",
                                                         makerFee: "0",
                                                         takerFee: "0",
                                       expirationUnixTimestampSec: "1534651346",
                                                     feeRecipient: "0x88a64b5e882e5ad851bea5e7a3c8ba7c523fecbe",
                                                             salt: "73665372381710778176321403164539964478925879098761330710742710411655889865098",
                                          exchangeContractAddress: "0x90fe2af704b34e0224bf2299c838e04d4dcf1364"                                     } }
        //
        // ---- limit orders --------------------------------------------------
        //
        //     {
        //       "unsignedTargetOrder": {
        //         "exchangeContractAddress": "0x516bdc037df84d70672b2d140835833d3623e451",
        //         "maker": "",
        //         "taker": "0x00ba938cc0df182c25108d7bf2ee3d37bce07513",
        //         "makerTokenAddress": "0x7cc7fdd065cfa9c7f4f6a3c1bfc6dfcb1a3177aa",
        //         "takerTokenAddress": "0x17f15936ef3a2da5593033f84487cbe9e268f02f",
        //         "feeRecipient": "0x88a64b5e882e5ad851bea5e7a3c8ba7c523fecbe",
        //         "makerTokenAmount": "10000000000000000000",
        //         "takerTokenAmount": "10000000000000000000",
        //         "makerFee": "0",
        //         "takerFee": "0",
        //         "expirationUnixTimestampSec": "525600",
        //         "salt": "37800593840622773016017857006417214310534675667008850948421364357744823963318",
        //         "ecSignature": {
        //           "v": 0,
        //           "r": "",
        //           "s": ""
        //         }
        //       },
        //       "unsignedMarketOrder": {
        //         "exchangeContractAddress": "0x516bdc037df84d70672b2d140835833d3623e451",
        //         "maker": "",
        //         "taker": "0x00ba938cc0df182c25108d7bf2ee3d37bce07513",
        //         "makerTokenAddress": "0x7cc7fdd065cfa9c7f4f6a3c1bfc6dfcb1a3177aa",
        //         "takerTokenAddress": "0x17f15936ef3a2da5593033f84487cbe9e268f02f",
        //         "feeRecipient": "0x88a64b5e882e5ad851bea5e7a3c8ba7c523fecbe",
        //         "makerTokenAmount": "10000000000000000000",
        //         "takerTokenAmount": "10000000000000000000",
        //         "makerFee": "0",
        //         "takerFee": "0",
        //         "expirationUnixTimestampSec": "525600",
        //         "salt": "37800593840622773016017857006417214310534675667008850948421364357744823963318",
        //         "ecSignature": {
        //           "v": 0,
        //           "r": "",
        //           "s": ""
        //         }
        //       },
        //       "marketOrderID": "892879202"
        //     }
        //
        // console.log (reserveResponse);
        log.magenta (reserveResponse);
        // process.exit ();
        // --------------------------------------------------------------------
        const marketOrder = this.extend (reserveResponse['unsignedMatchingOrder'], {
            'maker': this.uid.toLowerCase (),
        });
        const signedMarketOrder = this.signOrder (marketOrder)
        const serializedMarketOrder = serializers.serializeOrder (signedMarketOrder)
        const placeRequest = {
            'signedOrder': serializedMarketOrder,
            'marketOrderID': reserveResponse['marketOrderID'],
        };
        // return api.trade.placeMarketOrder({order})
        let placeMethod = method + 'Place';
        log.yellow (placeRequest)
        process.exit ();
        //     let placeResponse =  await this[placeMethod] (this.extend (placeRequest, params));
        //         {
        //         "targetOrder": {
        //             "orderHash": "0x94629386298dee69ae63cd3e414336ae153b3f02cffb9ffc53ad71e166615618",
        //             "amount": "100000000000"
        //         },
        //         "matchingOrder": {
        //             "orderHash": "0x3d6b287c1dc79262d2391ae2ca9d050fdbbab2c8b3180e4a46f9f321a7f1d7a9",
        //             "transactionHash": "0x5e6e75e1aa681b51b034296f62ac19be7460411a2ad94042dd8ba637e13eac0c",
        //             "amount": "100000000000"
        //         }
        //         }
        //     console.log (placeResponse);
        // process.exit ();
        //     send signed
        //     let id = undefined;
        //     let status = 'open';
        //     let filled = 0.0;
        //     let remaining = amount;
        //     if ('return' in response) {
        //         id = this.safeString (response['return'], this.getOrderIdKey ());
        //         if (id === '0') {
        //             id = this.safeString (response['return'], 'init_order_id');
        //             status = 'closed';
        //         }
        //         filled = this.safeFloat (response['return'], 'received', 0.0);
        //         remaining = this.safeFloat (response['return'], 'remains', amount);
        //     }
        //     let timestamp = this.milliseconds ();
        //     let order = {
        //         'id': id,
        //         'timestamp': timestamp,
        //         'datetime': this.iso8601 (timestamp),
        //         'lastTradeTimestamp': undefined,
        //         'status': status,
        //         'symbol': symbol,
        //         'type': type,
        //         'side': side,
        //         'price': price,
        //         'cost': price * filled,
        //         'amount': amount,
        //         'remaining': remaining,
        //         'filled': filled,
        //         'fee': undefined,
        //         'trades': undefined,
        //     };
        //     this.orders[id] = order;
        //     return this.extend ({ 'info': response }, order);
    }

    async cancelOrder (id, symbol = undefined, params = {}) {
        await this.loadMarkets ();
        let request = {
            'orderHash': id,
        };
        let response = await this.privateDeleteOrderOrderHash (this.extend (request, params));
        //
        //     {
        //       "canceledOrder": {
        //         "orderHash": "0x3d6b287c1dc79262d2391ae2ca9d050fdbbab2c8b3180e4a46f9f321a7f1d7a9",
        //         "amount": "100000000000"
        //       }
        //     }
        //
        return response;
    }

    parseOrderStatus (status) {
        let statuses = {
            '0': 'open',
            '1': 'closed',
            '2': 'canceled',
            '3': 'canceled', // or partially-filled and still open? https://github.com/ccxt/ccxt/issues/1594
        };
        if (status in statuses)
            return statuses[status];
        return status;
    }

    parseOrder (order, market = undefined) {
        //
        //     {
        //       "baseTokenAddress": "0x7cc7fdd065cfa9c7f4f6a3c1bfc6dfcb1a3177aa",
        //       "quoteTokenAddress": "0x17f15936ef3a2da5593033f84487cbe9e268f02f",
        //       "side": "buy",
        //       "amount": "10000000000000000000",
        //       "price": "1.000",
        //       "created": "1512929327792",
        //       "expires": "1512929897118",
        //       "zeroExOrder": {
        //         "exchangeContractAddress": "0x516bdc037df84d70672b2d140835833d3623e451",
        //         "maker": "0x006dc83e5b21854d4afc44c9b92a91e0349dda13",
        //         "taker": "0x00ba938cc0df182c25108d7bf2ee3d37bce07513",
        //         "makerTokenAddress": "0x7cc7fdd065cfa9c7f4f6a3c1bfc6dfcb1a3177aa",
        //         "takerTokenAddress": "0x17f15936ef3a2da5593033f84487cbe9e268f02f",
        //         "feeRecipient": "0x88a64b5e882e5ad851bea5e7a3c8ba7c523fecbe",
        //         "makerTokenAmount": "10000000000000000000",
        //         "takerTokenAmount": "10000000000000000000",
        //         "makerFee": "0",
        //         "takerFee": "0",
        //         "expirationUnixTimestampSec": "525600",
        //         "salt": "37800593840622773016017857006417214310534675667008850948421364357744823963318",
        //         "orderHash": "0x94629386298dee69ae63cd3e414336ae153b3f02cffb9ffc53ad71e166615618",
        //         "ecSignature": {
        //           "v": 28,
        //           "r": "0x5307b6a69e7cba8583e1de39efb93a9ae1afc11849e79d99f462e49c18c4d6e4",
        //           "s": "0x5950e82364227ccca95c70b47375e8911a2039d3040ba0684329634ebdced160"
        //         }
        //       }
        //     }
        //
        let zeroExOrder = this.safeValue (order, 'zeroExOrder');
        let id = zeroExOrder['orderHash'].toString ();
        let side = this.safeString (order, 'side');
        let timestamp = parseInt (order['created']) * 1000;
        let amount = this.fromWei (this.safeFloat (order, 'amount'));
        let price = this.safeFloat (order, 'price');
        let symbol = undefined;
        if (typeof market === 'undefined') {
            let baseId = this.safeString (order, 'baseTokenAddress');
            let quoteId = this.safeString (order, 'quoteTokenAddress');
            let marketId = baseId + '/' + quoteId;
            if (marketId in this.markets_by_id) {
                market = this.markets_by_id[marketId];
            }
        }
        if (typeof market !== 'undefined') {
            symbol = market['symbol'];
        }
        let status = undefined;
        let remaining = undefined;
        let filled = undefined;
        let cost = undefined;
        let fee = undefined;
        let result = {
            'info': order,
            'id': id,
            'symbol': symbol,
            'timestamp': timestamp,
            'datetime': this.iso8601 (timestamp),
            'lastTradeTimestamp': undefined,
            'type': 'limit',
            'side': side,
            'price': price,
            'cost': cost,
            'amount': amount,
            'remaining': remaining,
            'filled': filled,
            'status': status,
            'fee': fee,
            'trades': undefined,
        };
        return result;
    }

    async fetchOrder (id, symbol = undefined, params = {}) {
        await this.loadMarkets ();
        let request = {
            'orderHash': id,
        };
        let response = await this.publicGetOrderOrderHash (this.extend (request, params));
        //
        //     {
        //       "baseTokenAddress": "0x7cc7fdd065cfa9c7f4f6a3c1bfc6dfcb1a3177aa",
        //       "quoteTokenAddress": "0x17f15936ef3a2da5593033f84487cbe9e268f02f",
        //       "side": "buy",
        //       "amount": "10000000000000000000",
        //       "price": "1.000",
        //       "created": "1512929327792",
        //       "expires": "1512929897118",
        //       "zeroExOrder": {
        //         "exchangeContractAddress": "0x516bdc037df84d70672b2d140835833d3623e451",
        //         "maker": "0x006dc83e5b21854d4afc44c9b92a91e0349dda13",
        //         "taker": "0x00ba938cc0df182c25108d7bf2ee3d37bce07513",
        //         "makerTokenAddress": "0x7cc7fdd065cfa9c7f4f6a3c1bfc6dfcb1a3177aa",
        //         "takerTokenAddress": "0x17f15936ef3a2da5593033f84487cbe9e268f02f",
        //         "feeRecipient": "0x88a64b5e882e5ad851bea5e7a3c8ba7c523fecbe",
        //         "makerTokenAmount": "10000000000000000000",
        //         "takerTokenAmount": "10000000000000000000",
        //         "makerFee": "0",
        //         "takerFee": "0",
        //         "expirationUnixTimestampSec": "525600",
        //         "salt": "37800593840622773016017857006417214310534675667008850948421364357744823963318",
        //         "orderHash": "0x94629386298dee69ae63cd3e414336ae153b3f02cffb9ffc53ad71e166615618",
        //         "ecSignature": {
        //           "v": 28,
        //           "r": "0x5307b6a69e7cba8583e1de39efb93a9ae1afc11849e79d99f462e49c18c4d6e4",
        //           "s": "0x5950e82364227ccca95c70b47375e8911a2039d3040ba0684329634ebdced160"
        //         }
        //       }
        //     }
        //
        return this.parseOrder (response);
    }

    sign (path, api = 'public', method = 'GET', params = {}, headers = undefined, body = undefined) {
        let url = this.urls['api'] + '/' + this.version + '/' + this.implodeParams (path, params);
        let query = this.omit (params, this.extractParams (path));
        if (api === 'private') {
            this.checkRequiredCredentials ();
            let timestamp = this.seconds ().toString ();
            let prehash = this.apiKey + timestamp + method;
            if (method === 'POST') {
                body = this.json (query);
                prehash += body;
            } else {
                if (Object.keys (query).length) {
                    url += '?' + this.urlencode (query);
                }
                prehash += this.json ({});
            }
            let signature = this.hmac (this.encode (prehash), this.encode (this.secret), 'sha256', 'base64');
            headers = {
                'TOX-ACCESS-KEY': this.apiKey,
                'TOX-ACCESS-SIGN': signature,
                'TOX-ACCESS-TIMESTAMP': timestamp,
                'Content-Type': 'application/json',
                // 'Content-Length': body.length,
            };
        } else if (api === 'public') {
            if (Object.keys (query).length) {
                url += '?' + this.urlencode (query);
            }
        }
        return { 'url': url, 'method': method, 'body': body, 'headers': headers };
    }

    handleErrors (httpCode, reason, url, method, headers, body) {
        if (typeof body !== 'string')
            return; // fallback to default error handler
        if (body.length < 2)
            return; // fallback to default error handler
        // code 401 and plain body 'Authentication failed' (with single quotes)
        // this error is sent if you do not submit a proper Content-Type
        if (body === "'Authentication failed'") {
            throw new AuthenticationError (this.id + ' ' + body);
        }
        if ((body[0] === '{') || (body[0] === '[')) {
            let response = JSON.parse (body);
            if ('errors' in response) {
                //
                // {"message":"Schema validation failed for 'query'","errors":[{"name":"required","argument":"startTime","message":"requires property \"startTime\"","instance":{"baseTokenAddress":"0x6ff6c0ff1d68b964901f986d4c9fa3ac68346570","quoteTokenAddress":"0xd0a1e359811322d97991e03f863a0c30c2cf029c","interval":"300"},"property":"instance"}]}
                // {"message":"Logic validation failed for 'query'","errors":[{"message":"startTime should be between 0 and current date","type":"startTime"}]}
                //
                const message = this.safeString (response, 'error');
                const feedback = this.id + ' ' + this.json (response);
                const exceptions = this.exceptions;
                if (message in exceptions) {
                    throw new exceptions[message] (feedback);
                } else {
                    throw new ExchangeError (feedback);
                }
            }
        }
    }

    async request (path, api = 'public', method = 'GET', params = {}, headers = undefined, body = undefined) {
        let response = await this.fetch2 (path, api, method, params, headers, body);
        if (typeof response !== 'string') {
            throw new ExchangeError (this.id + ' returned a non-string response: ' + response.toString ());
        }
        if ((response[0] === '{' || response[0] === '[')) {
            return JSON.parse (response);
        }
        return response;
    }
};
