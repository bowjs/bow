const auth = require("basic-auth");
const bodyParser = require("koa-bodyparser");
const check = require("check-types");
const debug = require("debug")("dbow:InboundServer");
const log = require("debug")("bow:InboundServer");
const Koa = require("koa");
const Router = require("koa-router");

const assert = require("./utils/assert");
const statuses = require("./utils/statuses");

const HEALTH_CHECK_PATH = "/health";

async function connectToPubSub() {
  if (this.pubSubBuilder.isOperational()) {
    log("Connecting InboundServer to PubSub...");
    this.pubSub = await this.pubSubBuilder.build("BOW_PUSH");
    this.pubSub.onMessage(({ version, name, payload, audience }) =>
      this.middlewareServer.forward(version, name, payload, audience));
    this.forward = (version, name, payload, audience) =>
      this.pubSub.pushMessage({ version, name, payload, audience });
  }
}

async function disconnectFromPubSub() {
  if (check.assigned(this.pubSub)) {
    log("Disconnecting InboundServer from PubSub...");
    await this.pubSub.destroy();
  }
}

function basicAuth() {
  return async (context, next) => {
    const { name, pass } = auth(context) || {};
    if (name === this.config.username && pass === this.config.password) {
      await next();
    } else {
      log("Someone tried to push a message with wrong credentials: username '%s', password '%s'", name || "", pass || "");
      context.response.status = statuses.unauthorized;
    }
  };
}

function registerHealthCheck() {
  log("Registering 'GET %s'...", HEALTH_CHECK_PATH);
  return new Router()
    .get(HEALTH_CHECK_PATH, (context) => {
      context.response.status = statuses.ok;
      this.healthCheckDecorator(context);
    });
}

const registerInbound = (router) => function (inbound) {
  log("Registering 'POST %s'...", inbound.path);
  router.post(inbound.path, async (context) => {
    try {
      debug("Message received, trying to forward: %s", JSON.stringify(context.request.body));
      const { name, payload, audience } = await inbound.createMessageFromRequestBody(context.request.body);
      assert.nonEmptyString(name, "message's name");
      assert.audience(audience);
      this.forward(inbound.middlewareVersion, name, payload, audience);
      context.response.status = statuses.noContent;
    } catch (error) {
      const reason = error instanceof Error ? error.message : error;
      log("Could not forward message: %s", reason);
      context.throw(statuses.unprocessableEntity, reason);
    }
  });
};

function registerInbounds() {
  const router = new Router();
  this.inbounds.forEach(registerInbound(router).bind(this));
  return router;
}

module.exports = class InboundServer {

  constructor(inbounds, config, middlewareServer, pubSubBuilder, healthCheckDecorator) {
    this.inbounds = inbounds;
    this.config = config;
    this.middlewareServer = middlewareServer;
    this.pubSubBuilder = pubSubBuilder;
    this.healthCheckDecorator = healthCheckDecorator;
    this.pubSub = undefined;
    this.forward = middlewareServer.forward.bind(middlewareServer);
    Object.seal(this);
  }

  async start() {
    log("Starting InboundServer...");
    await connectToPubSub.call(this);
    const healthCheckRouter = registerHealthCheck.call(this);
    const inboundsRouter = registerInbounds.call(this);
    return new Koa()
      .use(healthCheckRouter.routes())
      .use(healthCheckRouter.allowedMethods())
      .use(basicAuth.call(this))
      .use(bodyParser())
      .use(inboundsRouter.routes())
      .use(inboundsRouter.allowedMethods());
  }

  async stop() {
    log("Stopping InboundServer...");
    await disconnectFromPubSub.call(this);
  }

  static get healthCheckPath() {
    return HEALTH_CHECK_PATH;
  }

};
