const crypto = require('crypto');
const axios = require('axios');

class BinancePay {
  constructor({
    apiKey,
    apiSecret,
    baseUrl = 'https://bpay.binanceapi.com',
    timeout = 20000
  }) {
    if (!apiKey) throw new Error('apiKey is required');
    if (!apiSecret) throw new Error('apiSecret is required');

    this.apiKey = String(apiKey).trim();
    this.apiSecret = String(apiSecret).trim();
    this.baseUrl = String(baseUrl || 'https://bpay.binanceapi.com').replace(/\/+$/, '');
    this.timeout = timeout;
  }

  getTimestamp() {
    return Date.now();
  }

  generateNonce(length = 32) {
    return crypto.randomBytes(length).toString('hex').slice(0, length);
  }

  signPayload(timestamp, nonce, payload = {}) {
    const payloadString = JSON.stringify(payload || {});
    const payloadToSign = `${timestamp}\n${nonce}\n${payloadString}\n`;

    return crypto
      .createHmac('sha512', this.apiSecret)
      .update(payloadToSign, 'utf8')
      .digest('hex')
      .toUpperCase();
  }

  async request(method, path, payload = {}) {
    const timestamp = this.getTimestamp();
    const nonce = this.generateNonce();
    const signature = this.signPayload(timestamp, nonce, payload);

    const response = await axios({
      method,
      url: `${this.baseUrl}${path}`,
      data: payload,
      timeout: this.timeout,
      headers: {
        'Content-Type': 'application/json;charset=utf-8',
        'BinancePay-Timestamp': String(timestamp),
        'BinancePay-Nonce': nonce,
        'BinancePay-Certificate-SN': this.apiKey,
        'BinancePay-Signature': signature,
        'User-Agent': 'custom-binance-pay-node'
      },
      validateStatus: () => true
    });

    return response.data;
  }

  async createOrder(params) {
    return this.request('POST', '/binancepay/openapi/v2/order', params);
  }

  async queryOrder({ prepayId, merchantTradeNo }) {
    if (!prepayId && !merchantTradeNo) {
      throw new Error('Either prepayId or merchantTradeNo is required');
    }

    return this.request('POST', '/binancepay/openapi/v2/order/query', {
      ...(prepayId ? { prepayId } : {}),
      ...(merchantTradeNo ? { merchantTradeNo } : {})
    });
  }

  async closeOrder({ prepayId, merchantTradeNo }) {
    if (!prepayId && !merchantTradeNo) {
      throw new Error('Either prepayId or merchantTradeNo is required');
    }

    return this.request('POST', '/binancepay/openapi/order/close', {
      ...(prepayId ? { prepayId } : {}),
      ...(merchantTradeNo ? { merchantTradeNo } : {})
    });
  }

  async refundOrder({ refundRequestId, prepayId, refundAmount, refundReason }) {
    if (!refundRequestId) throw new Error('refundRequestId is required');
    if (!prepayId) throw new Error('prepayId is required');
    if (refundAmount === undefined || refundAmount === null) {
      throw new Error('refundAmount is required');
    }

    return this.request('POST', '/binancepay/openapi/order/refund', {
      refundRequestId,
      prepayId,
      refundAmount,
      ...(refundReason ? { refundReason } : {})
    });
  }

  buildCreateOrderPayload({
    merchantTradeNo,
    amount,
    currency = 'USDT',
    goodsName,
    goodsDetail = '',
    terminalType = 'WAP',
    returnUrl,
    cancelUrl,
    webhookUrl,
    orderExpireTime,
    supportPayCurrency,
    passThroughInfo
  }) {
    if (!merchantTradeNo) throw new Error('merchantTradeNo is required');
    if (amount === undefined || amount === null) throw new Error('amount is required');
    if (!goodsName) throw new Error('goodsName is required');

    const payload = {
      env: { terminalType },
      merchantTradeNo,
      orderAmount: Number(amount),
      currency,
      goods: {
        goodsType: '02',
        goodsCategory: 'Z000',
        referenceGoodsId: merchantTradeNo,
        goodsName,
        goodsDetail
      }
    };

    if (returnUrl) payload.returnUrl = returnUrl;
    if (cancelUrl) payload.cancelUrl = cancelUrl;
    if (webhookUrl) payload.webhookUrl = webhookUrl;
    if (orderExpireTime) payload.orderExpireTime = orderExpireTime;
    if (supportPayCurrency) payload.supportPayCurrency = supportPayCurrency;
    if (passThroughInfo) payload.passThroughInfo = passThroughInfo;

    return payload;
  }
}

module.exports = BinancePay;
