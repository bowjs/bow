const check = require("check-types");
const clone = require("clone");
const log = require("debug")("bow:Bow");
const deepFreeze = require("deep-freeze");

const assert = require("./utils/assert");
const InboundServer = require("./InboundServer");
const normalizeVersion = require("./utils/normalizeVersion");
const Server = require("./Server");

const validateMiddlewareConfig = (middlewareConfig) => {
  if (check.assigned(middlewareConfig)) {
    assert.object(middlewareConfig, "config.middleware");
    if (check.assigned(middlewareConfig.logInterval)) {
      assert.integer(middlewareConfig.logInterval, "config.middleware.logInterval");
    }
  }
};

const validateInboundConfig = (inboundConfig) => {
  assert.object(inboundConfig, "config.inbound");
  assert.nonEmptyString(inboundConfig.realm, "config.inbound.realm");
  assert.nonEmptyString(inboundConfig.username, "config.inbound.username");
  assert.nonEmptyString(inboundConfig.password, "config.inbound.password");
};

const validateOutboundConfig = (outboundConfig) => {
  assert.object(outboundConfig, "config.outbound");
  assert.integer(outboundConfig.timeout, "config.outbound.timeout");
  assert.positive(outboundConfig.timeout, "config.outbound.timeout");
};

const validateConfig = (config) => {
  assert.object(config, "config");
  assert.integer(config.port, "config.port");
  assert.positive(config.port, "config.port");
  if (check.assigned(config.https)) {
    assert.object(config.https, "config.https");
  } else {
    log("WARNING: no HTTPS config has been provided, your Bow server will run on HTTP");
  }
  if (check.assigned(config.redis)) {
    assert.redisConfig(config.redis);
  } else {
    log("WARNING: no Redis config has been provided, your Bow server will be inconsistent if deployed on a clustered environment");
  }
  validateMiddlewareConfig(config.middleware);
  validateInboundConfig(config.inbound);
  validateOutboundConfig(config.outbound);
};

const findDuplicates = (array) => {
  const counts = new Map();
  array.forEach((element) => {
    const count = counts.get(element);
    counts.set(element, (check.assigned(count) ? count : 0) + 1);
  });
  return Array.from(counts.keys())
    .filter((count) => 1 < counts.get(count));
};

function validateMiddlewareState(middlewareVersions, inboundMiddlewareVersions, outboundMiddlewareVersions) {
  const middlewareDuplicatedVersions = findDuplicates(middlewareVersions);
  if (0 < middlewareDuplicatedVersions.length) {
    throw new Error(`Some middlewares have duplicated versions: 'v${middlewareDuplicatedVersions.join("', 'v")}'`);
  }
  const unusedByInboundsMiddlewareVersions = middlewareVersions.filter((middlewareVersion) =>
    inboundMiddlewareVersions.indexOf(middlewareVersion) < 0);
  if (0 < unusedByInboundsMiddlewareVersions.length) {
    throw new Error(`Some middlewares are unused by inbounds: 'v${unusedByInboundsMiddlewareVersions.join("', 'v")}'`);
  }
  const unusedByOutboundsMiddlewareVersions = middlewareVersions.filter((middlewareVersion) =>
    outboundMiddlewareVersions.indexOf(middlewareVersion) < 0);
  if (0 < unusedByOutboundsMiddlewareVersions.length) {
    throw new Error(`Some middlewares are unused by outbounds: 'v${unusedByOutboundsMiddlewareVersions.join("', 'v")}'`);
  }
}

function validateBoundState(boundName, idName, middlewareVersions, boundMiddlewareVersions) {
  const boundDuplicatedPaths = findDuplicates(this[`${boundName}s`].map((bound) => bound[idName]));
  if (0 < boundDuplicatedPaths.length) {
    throw new Error(`Some ${boundName}s have duplicated ${idName}s: '${boundDuplicatedPaths.join("', '")}'`);
  }
  const unexistingBoundMiddlewareVersions = boundMiddlewareVersions.filter((boundMiddlewareVersion) =>
    middlewareVersions.indexOf(boundMiddlewareVersion) < 0);
  if (0 < unexistingBoundMiddlewareVersions.length) {
    throw new Error(`Some ${boundName}s have unexisting middleware versions: 'v${unexistingBoundMiddlewareVersions.join("', 'v")}'`);
  }
}

function validateState() {
  if (0 === this.middlewares.length) {
    throw new Error("No middleware has been registered");
  }
  if (0 === this.inbounds.length) {
    throw new Error("No inbound has been registered");
  }
  if (0 === this.outbounds.length) {
    throw new Error("No outbound has been registered");
  }
  const middlewareVersions = this.middlewares.map((middleware) => middleware.version);
  const inboundMiddlewareVersions = this.inbounds.map((inbound) => inbound.middlewareVersion);
  const outboundMiddlewareVersions = this.outbounds.map((outbound) => outbound.middlewareVersion);
  validateMiddlewareState.call(this, middlewareVersions, inboundMiddlewareVersions, outboundMiddlewareVersions);
  validateBoundState.call(this, "inbound", "path", middlewareVersions, inboundMiddlewareVersions);
  validateBoundState.call(this, "outbound", "version", middlewareVersions, outboundMiddlewareVersions);
}

module.exports = class Bow {

  constructor(config) {
    validateConfig(config);
    const clonedConfig = clone(config);
    if (!check.assigned(clonedConfig.middleware)) {
      clonedConfig.middleware = {};
    }
    this.config = Object.freeze(clonedConfig);
    deepFreeze(this.config.middleware);
    deepFreeze(this.config.inbound);
    deepFreeze(this.config.outbound);
    this.middlewares = [];
    this.inbounds = [];
    this.outbounds = [];
    this.healthCheckDecorator = () => {}; // eslint-disable-line no-empty-function
    Object.seal(this);
  }

  middleware(config) {
    assert.object(config, "middleware's config");
    const normalizedVersion = normalizeVersion(config.version);
    assert.nonEmptyString(normalizedVersion, "middleware's version");
    assert.function(config.createCriteriaFromListenerDetails, "middleware's createCriteriaFromListenerDetails");
    this.middlewares.push(deepFreeze(clone({
      version: normalizedVersion,
      createCriteriaFromListenerDetails: config.createCriteriaFromListenerDetails
    })));
    return this;
  }

  inbound(config) {
    assert.object(config, "inbound's config");
    const normalizedMiddlewareVersion = normalizeVersion(config.middlewareVersion);
    assert.nonEmptyString(config.path, "inbound's path");
    if (InboundServer.healthCheckPath === config.path) {
      throw new Error(`'${config.path}' is reserved, it cannot be used for an inbound`);
    }
    assert.function(config.createMessageFromRequestBody, "inbound's createMessageFromRequestBody");
    assert.nonEmptyString(normalizedMiddlewareVersion, "inbound's middlewareVersion");
    this.inbounds.push(deepFreeze(clone({
      path: config.path,
      createMessageFromRequestBody: config.createMessageFromRequestBody,
      middlewareVersion: normalizedMiddlewareVersion
    })));
    return this;
  }

  outbound(config) {
    assert.object(config, "outbound's config");
    const normalizedVersion = normalizeVersion(config.version);
    const normalizedMiddlewareVersion = normalizeVersion(config.middlewareVersion);
    assert.nonEmptyString(normalizedVersion, "outbound's version");
    assert.function(config.createListenerDetailsFromToken, "outbound's createListenerDetailsFromToken");
    assert.nonEmptyString(normalizedMiddlewareVersion, "outbound's middlewareVersion");
    this.outbounds.push(deepFreeze(clone({
      version: normalizedVersion,
      createListenerDetailsFromToken: config.createListenerDetailsFromToken,
      middlewareVersion: normalizedMiddlewareVersion
    })));
    return this;
  }

  healthCheck(healthCheckDecorator) {
    assert.function(healthCheckDecorator, "health check decorator");
    this.healthCheckDecorator = healthCheckDecorator;
    return this;
  }

  start() {
    validateState.call(this);
    deepFreeze(this.middlewares);
    deepFreeze(this.inbounds);
    deepFreeze(this.outbounds);
    return new Server(this).start();
  }

};
