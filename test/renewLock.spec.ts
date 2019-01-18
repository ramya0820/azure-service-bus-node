// Copyright (c) Microsoft. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.

import chai from "chai";
const should = chai.should();
import chaiAsPromised from "chai-as-promised";
import dotenv from "dotenv";
dotenv.config();
chai.use(chaiAsPromised);
import {
  Namespace,
  QueueClient,
  SendableMessageInfo,
  generateUuid,
  TopicClient,
  SubscriptionClient,
  OnMessage,
  ServiceBusMessage,
  MessagingError,
  OnError
} from "../lib";
import { delay } from "rhea-promise";

let namespace: Namespace;

let partitionedQueueClient: QueueClient;
let partitionedTopicClient: TopicClient;
let partitionedSubscriptionClient: SubscriptionClient;

let unpartitionedQueueClient: QueueClient;
let unpartitionedTopicClient: TopicClient;
let unpartitionedSubscriptionClient: SubscriptionClient;

async function beforeEachTest(): Promise<void> {
  // The tests in this file expect the env variables to contain the connection string and
  // the names of empty queue/topic/subscription that are to be tested

  if (!process.env.SERVICEBUS_CONNECTION_STRING) {
    throw new Error(
      "Define SERVICEBUS_CONNECTION_STRING in your environment before running integration tests."
    );
  }
  if (
    !process.env.TOPIC_NAME ||
    !process.env.TOPIC_NAME_NO_PARTITION ||
    !process.env.TOPIC_NAME_NO_PARTITION_SESSION ||
    !process.env.TOPIC_NAME_SESSION
  ) {
    throw new Error(
      "Define TOPIC_NAME, TOPIC_NAME_NO_PARTITION, TOPIC_NAME_SESSION & TOPIC_NAME_NO_PARTITION_SESSION in your environment before running integration tests."
    );
  }
  if (
    !process.env.QUEUE_NAME ||
    !process.env.QUEUE_NAME_NO_PARTITION ||
    !process.env.QUEUE_NAME_NO_PARTITION_SESSION ||
    !process.env.QUEUE_NAME_SESSION
  ) {
    throw new Error(
      "Define QUEUE_NAME, QUEUE_NAME_NO_PARTITION, QUEUE_NAME_SESSION & QUEUE_NAME_NO_PARTITION_SESSION in your environment before running integration tests."
    );
  }
  if (
    !process.env.SUBSCRIPTION_NAME ||
    !process.env.SUBSCRIPTION_NAME_NO_PARTITION ||
    !process.env.SUBSCRIPTION_NAME_NO_PARTITION_SESSION ||
    !process.env.SUBSCRIPTION_NAME_SESSION
  ) {
    throw new Error(
      "Define SUBSCRIPTION_NAME, SUBSCRIPTION_NAME_NO_PARTITION, SUBSCRIPTION_NAME_SESSION & SUBSCRIPTION_NAME_NO_PARTITION_SESSION in your environment before running integration tests."
    );
  }

  namespace = Namespace.createFromConnectionString(process.env.SERVICEBUS_CONNECTION_STRING);

  // Partitioned Queues and Subscriptions
  partitionedQueueClient = namespace.createQueueClient(process.env.QUEUE_NAME);
  partitionedTopicClient = namespace.createTopicClient(process.env.TOPIC_NAME);
  partitionedSubscriptionClient = namespace.createSubscriptionClient(
    process.env.TOPIC_NAME,
    process.env.SUBSCRIPTION_NAME
  );

  // Unpartitioned Queues and Subscriptions
  unpartitionedQueueClient = namespace.createQueueClient(process.env.QUEUE_NAME_NO_PARTITION);
  unpartitionedTopicClient = namespace.createTopicClient(process.env.TOPIC_NAME_NO_PARTITION);
  unpartitionedSubscriptionClient = namespace.createSubscriptionClient(
    process.env.TOPIC_NAME_NO_PARTITION,
    process.env.SUBSCRIPTION_NAME_NO_PARTITION
  );

  const peekedPartitionedQueueMsg = await partitionedQueueClient.peek();
  if (peekedPartitionedQueueMsg.length) {
    throw new Error("Please use an empty partitioned queue for integration testing");
  }

  const peekedPartitionedSubscriptionMsg = await partitionedSubscriptionClient.peek();
  if (peekedPartitionedSubscriptionMsg.length) {
    throw new Error("Please use an empty partitioned Subscription for integration testing");
  }

  const peekedUnPartitionedQueueMsg = await unpartitionedQueueClient.peek();
  if (peekedUnPartitionedQueueMsg.length) {
    throw new Error("Please use an empty unpartitioned queue for integration testing");
  }

  const peekedUnPartitionedSubscriptionMsg = await unpartitionedSubscriptionClient.peek();
  if (peekedUnPartitionedSubscriptionMsg.length) {
    throw new Error("Please use an empty unpartitioned Subscription for integration testing");
  }
}

async function afterEachTest(): Promise<void> {
  await namespace.close();
}

const testMessage: SendableMessageInfo = {
  body: "hello-world-1",
  messageId: generateUuid()
};

const lockDurationInMilliseconds = 30000;

let uncaughtErrorFromHandlers: Error | undefined;

const onError: OnError = (err: MessagingError | Error) => {
  uncaughtErrorFromHandlers = err;
};

function assertTimestampsAreApproximatelyEqual(
  actualTimeInUTC: Date | undefined,
  expectedTimeInUTC: Date,
  label: string
): void {
  if (actualTimeInUTC) {
    should.equal(
      Math.pow((actualTimeInUTC.valueOf() - expectedTimeInUTC.valueOf()) / 1000, 2) < 4,
      true,
      `${label}: Actual time ${actualTimeInUTC} must be approximately equal to ${expectedTimeInUTC}`
    );
  }
}

//

// Tests for Lock Renewal, see -  https://github.com/Azure/azure-service-bus-node/issues/103
// Receive a msg using Batch Receiver, test renewLock()
async function testBatchReceiverManualLockRenewalHappyCase(
  senderClient: QueueClient | TopicClient,
  receiverClient: QueueClient | SubscriptionClient
): Promise<void> {
  await senderClient.send(testMessage);

  const msgs = await receiverClient.receiveBatch(1);

  // Compute expected initial lock duration
  const expectedLockExpiryTimeUtc = new Date();
  expectedLockExpiryTimeUtc.setSeconds(
    expectedLockExpiryTimeUtc.getSeconds() + lockDurationInMilliseconds / 1000
  );

  should.equal(Array.isArray(msgs), true);
  should.equal(msgs.length, 1);
  should.equal(msgs[0].body, testMessage.body);
  should.equal(msgs[0].messageId, testMessage.messageId);

  // Verify actual lock duration is reset
  assertTimestampsAreApproximatelyEqual(
    msgs[0].lockedUntilUtc,
    expectedLockExpiryTimeUtc,
    "Initial"
  );

  // Sleeping 10 seconds...
  await delay(10000);

  await receiverClient.renewLock(msgs[0]);

  // Compute expected lock duration after 10 seconds of sleep
  expectedLockExpiryTimeUtc.setSeconds(expectedLockExpiryTimeUtc.getSeconds() + 10);

  // Verify actual lock duration is reset
  assertTimestampsAreApproximatelyEqual(
    msgs[0].lockedUntilUtc,
    expectedLockExpiryTimeUtc,
    "After first renewal"
  );

  // Sleeping 5 more seconds...
  await delay(5000);

  await receiverClient.renewLock(msgs[0]);

  // Compute expected lock duration after 5 more seconds of sleep
  expectedLockExpiryTimeUtc.setSeconds(expectedLockExpiryTimeUtc.getSeconds() + 5);

  // Verify actual lock duration is reset
  assertTimestampsAreApproximatelyEqual(
    msgs[0].lockedUntilUtc,
    expectedLockExpiryTimeUtc,
    "After second renewal"
  );

  await msgs[0].complete();
}

// Receive a msg using Batch Receiver, wait until its lock expires, completing it now results in error
async function testBatchReceiverManualLockRenewalErrorOnLockExpiry(
  senderClient: QueueClient | TopicClient,
  receiverClient: QueueClient | SubscriptionClient
): Promise<void> {
  await senderClient.send(testMessage);

  const msgs = await receiverClient.receiveBatch(1);

  should.equal(Array.isArray(msgs), true);
  should.equal(msgs.length, 1);
  should.equal(msgs[0].body, testMessage.body);
  should.equal(msgs[0].messageId, testMessage.messageId);

  // Sleeping 30 seconds...
  await delay(lockDurationInMilliseconds + 1000);

  let errorWasThrown: boolean = false;
  await msgs[0].complete().catch((err) => {
    should.equal(err.name, "MessageLockLostError");
    errorWasThrown = true;
  });

  should.equal(errorWasThrown, true, "Error thrown flag must be true");

  // Clean up any left over messages
  const unprocessedMsgs = await receiverClient.receiveBatch(1);
  await unprocessedMsgs[0].complete();
}

// Tests for Lock Renewal, see -  https://github.com/Azure/azure-service-bus-node/issues/103
// Receive a msg using Batch Receiver, test renewLock()
async function testStreamingReceiverManualLockRenewalHappyCase(
  senderClient: QueueClient | TopicClient,
  receiverClient: QueueClient | SubscriptionClient
): Promise<void> {
  let numOfMessagesReceived = 0;

  await senderClient.send(testMessage);

  const onMessage: OnMessage = async (brokeredMessage: ServiceBusMessage) => {
    if (numOfMessagesReceived < 1) {
      numOfMessagesReceived++;

      should.equal(brokeredMessage.body, testMessage.body);
      should.equal(brokeredMessage.messageId, testMessage.messageId);

      // Compute expected initial lock duration
      const expectedLockExpiryTimeUtc = new Date();
      expectedLockExpiryTimeUtc.setSeconds(
        expectedLockExpiryTimeUtc.getSeconds() + lockDurationInMilliseconds / 1000
      );

      // Verify actual lock duration is reset
      assertTimestampsAreApproximatelyEqual(
        brokeredMessage.lockedUntilUtc,
        expectedLockExpiryTimeUtc,
        "Initial"
      );

      // Sleeping 10 seconds...
      await delay(10000);

      await receiverClient.renewLock(brokeredMessage);

      // Compute expected lock duration after 10 seconds of sleep
      expectedLockExpiryTimeUtc.setSeconds(expectedLockExpiryTimeUtc.getSeconds() + 10);

      // Verify actual lock duration is reset
      assertTimestampsAreApproximatelyEqual(
        brokeredMessage.lockedUntilUtc,
        expectedLockExpiryTimeUtc,
        "After first renewal"
      );

      // Sleeping 5 more seconds...
      await delay(5000);

      await receiverClient.renewLock(brokeredMessage);

      // Compute expected lock duration after 5 more seconds of sleep
      expectedLockExpiryTimeUtc.setSeconds(expectedLockExpiryTimeUtc.getSeconds() + 5);

      // Verify actual lock duration is reset
      assertTimestampsAreApproximatelyEqual(
        brokeredMessage.lockedUntilUtc,
        expectedLockExpiryTimeUtc,
        "After second renewal"
      );

      await brokeredMessage.complete();
    }
  };

  const receiveListener = receiverClient.receive(onMessage, onError, {
    autoComplete: false,
    maxAutoRenewDurationInSeconds: 0
  });
  await delay(40000);
  await receiveListener.stop();

  if (uncaughtErrorFromHandlers) {
    chai.assert.fail(uncaughtErrorFromHandlers.message);
  }

  should.equal(numOfMessagesReceived, 1);
}

// Receive a msg using Batch Receiver, wait until its lock expires, completing it now results in error
async function testStreamingReceiverManualLockRenewalErrorOnLockExpiry(
  senderClient: QueueClient | TopicClient,
  receiverClient: QueueClient | SubscriptionClient
): Promise<void> {
  let numOfMessagesReceived = 0;

  await senderClient.send(testMessage);

  const onMessage: OnMessage = async (brokeredMessage: ServiceBusMessage) => {
    if (numOfMessagesReceived < 1) {
      numOfMessagesReceived++;

      should.equal(brokeredMessage.body, testMessage.body);
      should.equal(brokeredMessage.messageId, testMessage.messageId);

      // Sleeping 30 seconds...
      await delay(lockDurationInMilliseconds);

      let errorWasThrown: boolean = false;
      await brokeredMessage.complete().catch((err) => {
        should.equal(err.name, "MessageLockLostError");
        errorWasThrown = true;
      });

      should.equal(errorWasThrown, true, "Error thrown flag must be true");
    }
  };

  const receiveListener = receiverClient.receive(onMessage, onError, {
    autoComplete: false,
    maxAutoRenewDurationInSeconds: 0
  });
  await delay(lockDurationInMilliseconds + 5000);
  await receiveListener.stop();

  if (uncaughtErrorFromHandlers) {
    chai.assert.fail(uncaughtErrorFromHandlers.message);
  }

  should.equal(numOfMessagesReceived, 1);

  // Clean up any left over messages
  const unprocessedMsgs = await receiverClient.receiveBatch(1);
  await unprocessedMsgs[0].complete();
}

// Receive a msg using Streaming Receiver, whitebox test on 20 second increment
async function testAutoLockRenewalConfigWhiteBox20SecondIncrement(
  senderClient: QueueClient | TopicClient,
  receiverClient: QueueClient | SubscriptionClient,
  maxAutoRenewDurationInSeconds: number,
  receiveClientTimeoutInSeconds: number
): Promise<void> {
  let numOfMessagesReceived = 0;

  await senderClient.send(testMessage);

  const onMessage: OnMessage = async (brokeredMessage: ServiceBusMessage) => {
    if (numOfMessagesReceived < 1) {
      numOfMessagesReceived++;

      should.equal(brokeredMessage.body, testMessage.body);
      should.equal(brokeredMessage.messageId, testMessage.messageId);

      // Compute expected initial lock duration
      const expectedLockExpiryTimeUtc = new Date();
      expectedLockExpiryTimeUtc.setSeconds(
        expectedLockExpiryTimeUtc.getSeconds() + lockDurationInMilliseconds / 1000
      );

      // Verify actual lock duration is reset
      assertTimestampsAreApproximatelyEqual(
        brokeredMessage.lockedUntilUtc,
        expectedLockExpiryTimeUtc,
        "Initial"
      );

      // Sleeping 30 seconds...
      await delay(lockDurationInMilliseconds);

      // Compute expected lock duration after 30 seconds of sleep
      expectedLockExpiryTimeUtc.setSeconds(expectedLockExpiryTimeUtc.getSeconds() + 20);

      // Verify actual lock duration is reset
      assertTimestampsAreApproximatelyEqual(
        brokeredMessage.lockedUntilUtc,
        expectedLockExpiryTimeUtc,
        "After 30 seconds"
      );

      // Sleeping 20 seconds...
      await delay(20000);

      // Compute expected lock duration after 20 more seconds of sleep
      expectedLockExpiryTimeUtc.setSeconds(expectedLockExpiryTimeUtc.getSeconds() + 20);

      // Verify actual lock duration is reset
      assertTimestampsAreApproximatelyEqual(
        brokeredMessage.lockedUntilUtc,
        expectedLockExpiryTimeUtc,
        "After 50 seconds"
      );

      // Sleeping 20 seconds...
      await delay(20000);

      // Compute expected lock duration after 20 more seconds of sleep
      expectedLockExpiryTimeUtc.setSeconds(expectedLockExpiryTimeUtc.getSeconds() + 20);

      // Verify actual lock duration is reset
      assertTimestampsAreApproximatelyEqual(
        brokeredMessage.lockedUntilUtc,
        expectedLockExpiryTimeUtc,
        "After 70 seconds"
      );

      await brokeredMessage.complete();
    }
  };

  const receiveListener = receiverClient.receive(onMessage, onError, {
    autoComplete: false,
    maxAutoRenewDurationInSeconds: maxAutoRenewDurationInSeconds
  });

  await delay(receiveClientTimeoutInSeconds * 1000);
  await receiveListener.stop();

  if (uncaughtErrorFromHandlers) {
    chai.assert.fail(uncaughtErrorFromHandlers.message);
  }

  should.equal(numOfMessagesReceived, 1);
}

interface AutoLockRenewalTestOptions {
  maxAutoRenewDurationInSeconds: number | undefined;
  receiveClientTimeoutInSeconds: number;
  delayBeforeAttemptingToReceiveInSeconds: number;
  expectedIncreaseInLockDurationInSeconds: number;
  willCompleteFail: boolean;
}

// Receive a msg using Streaming Receiver, lock expires after time elapses by value set in AutoLockRenewal configuration.
async function testAutoLockRenewalConfigBehavior(
  senderClient: QueueClient | TopicClient,
  receiverClient: QueueClient | SubscriptionClient,
  options: AutoLockRenewalTestOptions
): Promise<void> {
  let numOfMessagesReceived = 0;

  await senderClient.send(testMessage);

  const onMessage: OnMessage = async (brokeredMessage: ServiceBusMessage) => {
    if (numOfMessagesReceived < 1) {
      numOfMessagesReceived++;

      should.equal(brokeredMessage.body, testMessage.body);
      should.equal(brokeredMessage.messageId, testMessage.messageId);

      // Compute expected initial lock duration
      const expectedLockExpiryTimeUtc = new Date();
      console.log("Time now: ", expectedLockExpiryTimeUtc);
      expectedLockExpiryTimeUtc.setSeconds(
        expectedLockExpiryTimeUtc.getSeconds() + lockDurationInMilliseconds / 1000
      );
      console.log("Initial Expiry: ", expectedLockExpiryTimeUtc);

      // Verify actual lock duration is reset
      assertTimestampsAreApproximatelyEqual(
        brokeredMessage.lockedUntilUtc,
        expectedLockExpiryTimeUtc,
        "Initial"
      );

      // Sleeping...
      await delay(options.delayBeforeAttemptingToReceiveInSeconds * 1000);

      // Compute expected lock duration after induced delay
      expectedLockExpiryTimeUtc.setSeconds(
        expectedLockExpiryTimeUtc.getSeconds() + options.expectedIncreaseInLockDurationInSeconds
      );

      // Verify actual lock duration is reset
      assertTimestampsAreApproximatelyEqual(
        brokeredMessage.lockedUntilUtc,
        expectedLockExpiryTimeUtc,
        "After induced delay"
      );

      let errorWasThrown: boolean = false;
      await brokeredMessage.complete().catch((err) => {
        should.equal(err.name, "MessageLockLostError");
        errorWasThrown = true;
      });

      should.equal(errorWasThrown, options.willCompleteFail, "Error Thrown flag value mismatch");
    }
  };

  const receiveListener = receiverClient.receive(onMessage, onError, {
    autoComplete: false,
    maxAutoRenewDurationInSeconds: options.maxAutoRenewDurationInSeconds
  });
  await delay(options.receiveClientTimeoutInSeconds * 1000);
  await receiveListener.stop();

  if (uncaughtErrorFromHandlers) {
    chai.assert.fail(uncaughtErrorFromHandlers.message);
  }

  should.equal(numOfMessagesReceived, 1);

  if (options.willCompleteFail) {
    // Clean up any left over messages
    const unprocessedMsgs = await receiverClient.receiveBatch(1);
    await unprocessedMsgs[0].complete();
  }
}

describe("Partitioned Queues - Lock Renewal - Peeklock Mode", function(): void {
  let senderClient: QueueClient | TopicClient;
  let receiverClient: QueueClient | SubscriptionClient;
  beforeEach(async () => {
    await beforeEachTest();

    senderClient = partitionedQueueClient;
    receiverClient = partitionedQueueClient;
  });

  afterEach(async () => {
    await afterEachTest();
  });

  it(`renewLock() with Batch Receiver resets lock duration each time.`, async function(): Promise<
    void
  > {
    await testBatchReceiverManualLockRenewalHappyCase(senderClient, receiverClient);
  });

  it(`Receive a msg using Batch Receiver, wait until its lock expires, completing it now results in error`, async function(): Promise<
    void
  > {
    await testBatchReceiverManualLockRenewalErrorOnLockExpiry(senderClient, receiverClient);
  });

  it("Receives a message using Streaming Receiver renewLock() resets lock duration each time.", async function(): Promise<
    void
  > {
    await testStreamingReceiverManualLockRenewalHappyCase(senderClient, receiverClient);
  });

  it("Receive a msg using Streaming Receiver, wait until its lock expires, completing it now results in error", async function(): Promise<
    void
  > {
    await testStreamingReceiverManualLockRenewalErrorOnLockExpiry(senderClient, receiverClient);
  });

  it("Receive a msg using Streaming Receiver, whitebox test on 20 second increment", async function(): Promise<
    void
  > {
    /*
        maxAutoRenewDurationInSeconds: number,
        receiveClientTimeoutInSeconds: number
        */
    await testAutoLockRenewalConfigWhiteBox20SecondIncrement(senderClient, receiverClient, 60, 80);
  });

  it("Receive a msg using Streaming Receiver, lock expires after 30 sec when auto renewal is disabled", async function(): Promise<
    void
  > {
    await testAutoLockRenewalConfigBehavior(senderClient, receiverClient, {
      maxAutoRenewDurationInSeconds: 0,
      receiveClientTimeoutInSeconds: 40,
      delayBeforeAttemptingToReceiveInSeconds: 31,
      expectedIncreaseInLockDurationInSeconds: 0,
      willCompleteFail: true
    });
    // Complete fails as expected
  });

  it("Receive a msg using Streaming Receiver, lock expires after 90 seconds when config value is 45 seconds", async function(): Promise<
    void
  > {
    await testAutoLockRenewalConfigBehavior(senderClient, receiverClient, {
      maxAutoRenewDurationInSeconds: 45,
      receiveClientTimeoutInSeconds: 100,
      delayBeforeAttemptingToReceiveInSeconds: 91,
      expectedIncreaseInLockDurationInSeconds: 60,
      willCompleteFail: true
    });
    // ERROR:
    // Lock expiry time increases by 60 seconds
    // Complete fails after 90 seconds
  });

  it("Receive a msg using Streaming Receiver, lock expires after 300 seconds when config value is undefined", async function(): Promise<
    void
  > {
    await testAutoLockRenewalConfigBehavior(senderClient, receiverClient, {
      maxAutoRenewDurationInSeconds: undefined,
      receiveClientTimeoutInSeconds: 330,
      delayBeforeAttemptingToReceiveInSeconds: 305,
      expectedIncreaseInLockDurationInSeconds: 300,
      willCompleteFail: false
    });
    // ERROR:
    // Lock expiry time increases by 300 seconds
    // Complete does not fail after 300 seconds
  });
});

describe("Unpartitioned Queues - Lock Renewal - Peeklock Mode", function(): void {
  let senderClient: QueueClient | TopicClient;
  let receiverClient: QueueClient | SubscriptionClient;
  beforeEach(async () => {
    await beforeEachTest();

    senderClient = unpartitionedQueueClient;
    receiverClient = unpartitionedQueueClient;
  });

  afterEach(async () => {
    await afterEachTest();
  });

  it("renewLock() with Batch Receiver resets lock duration each time.", async function(): Promise<
    void
  > {
    await testBatchReceiverManualLockRenewalHappyCase(senderClient, receiverClient);
  });

  it("Receive a msg using Batch Receiver, wait until its lock expires, completing it now results in error", async function(): Promise<
    void
  > {
    await testBatchReceiverManualLockRenewalErrorOnLockExpiry(senderClient, receiverClient);
  });

  it("Receives a message using Streaming Receiver renewLock() resets lock duration each time.", async function(): Promise<
    void
  > {
    await testStreamingReceiverManualLockRenewalHappyCase(senderClient, receiverClient);
  });

  it("Receive a msg using Streaming Receiver, wait until its lock expires, completing it now results in error", async function(): Promise<
    void
  > {
    await testStreamingReceiverManualLockRenewalErrorOnLockExpiry(senderClient, receiverClient);
  });

  it("Receive a msg using Streaming Receiver, whitebox test on 20 second increment", async function(): Promise<
    void
  > {
    /*
    maxAutoRenewDurationInSeconds: number,
    receiveClientTimeoutInSeconds: number
    */
    await testAutoLockRenewalConfigWhiteBox20SecondIncrement(senderClient, receiverClient, 60, 80);
  });

  it("Receive a msg using Streaming Receiver, lock expires after 30 sec when auto renewal is disabled", async function(): Promise<
    void
  > {
    await testAutoLockRenewalConfigBehavior(senderClient, receiverClient, {
      maxAutoRenewDurationInSeconds: 0,
      receiveClientTimeoutInSeconds: 40,
      delayBeforeAttemptingToReceiveInSeconds: 31,
      expectedIncreaseInLockDurationInSeconds: 0,
      willCompleteFail: true
    });
    // Complete fails as expected
  });

  it("Receive a msg using Streaming Receiver, lock expires after 90 seconds when config value is 45 seconds", async function(): Promise<
    void
  > {
    await testAutoLockRenewalConfigBehavior(senderClient, receiverClient, {
      maxAutoRenewDurationInSeconds: 45,
      receiveClientTimeoutInSeconds: 100,
      delayBeforeAttemptingToReceiveInSeconds: 91,
      expectedIncreaseInLockDurationInSeconds: 60,
      willCompleteFail: true
    });
    // ERROR:
    // Lock expiry time increases by 60 seconds
    // Complete fails after 90 seconds
  });

  it("Receive a msg using Streaming Receiver, lock expires after 300 seconds when config value is undefined", async function(): Promise<
    void
  > {
    await testAutoLockRenewalConfigBehavior(senderClient, receiverClient, {
      maxAutoRenewDurationInSeconds: undefined,
      receiveClientTimeoutInSeconds: 330,
      delayBeforeAttemptingToReceiveInSeconds: 305,
      expectedIncreaseInLockDurationInSeconds: 300,
      willCompleteFail: false
    });
    // ERROR:
    // Lock expiry time increases by 300 seconds
    // Complete does not fail after 300 seconds
  });
});

describe("Partitioned Topics/Subscription - Lock Renewal - Peeklock Mode", function(): void {
  let senderClient: QueueClient | TopicClient;
  let receiverClient: QueueClient | SubscriptionClient;
  beforeEach(async () => {
    await beforeEachTest();

    senderClient = partitionedTopicClient;
    receiverClient = partitionedSubscriptionClient;
  });

  afterEach(async () => {
    await afterEachTest();
  });

  it("renewLock() with Batch Receiver resets lock duration each time.", async function(): Promise<
    void
  > {
    await testBatchReceiverManualLockRenewalHappyCase(senderClient, receiverClient);
  });

  it("Receive a msg using Batch Receiver, wait until its lock expires, completing it now results in error", async function(): Promise<
    void
  > {
    await testBatchReceiverManualLockRenewalErrorOnLockExpiry(senderClient, receiverClient);
  });

  it("Receives a message using Streaming Receiver renewLock() resets lock duration each time.", async function(): Promise<
    void
  > {
    await testStreamingReceiverManualLockRenewalHappyCase(senderClient, receiverClient);
  });

  it("Receive a msg using Streaming Receiver, wait until its lock expires, completing it now results in error", async function(): Promise<
    void
  > {
    await testStreamingReceiverManualLockRenewalErrorOnLockExpiry(senderClient, receiverClient);
  });

  it("Receive a msg using Streaming Receiver, whitebox test on 20 second increment", async function(): Promise<
    void
  > {
    /*
    maxAutoRenewDurationInSeconds: number,
    receiveClientTimeoutInSeconds: number
    */
    await testAutoLockRenewalConfigWhiteBox20SecondIncrement(senderClient, receiverClient, 60, 80);
  });

  it("Receive a msg using Streaming Receiver, lock expires after 30 sec when auto renewal is disabled", async function(): Promise<
    void
  > {
    await testAutoLockRenewalConfigBehavior(senderClient, receiverClient, {
      maxAutoRenewDurationInSeconds: 0,
      receiveClientTimeoutInSeconds: 40,
      delayBeforeAttemptingToReceiveInSeconds: 31,
      expectedIncreaseInLockDurationInSeconds: 0,
      willCompleteFail: true
    });
    // Complete fails as expected
  });

  it("Receive a msg using Streaming Receiver, lock expires after 90 seconds when config value is 45 seconds", async function(): Promise<
    void
  > {
    await testAutoLockRenewalConfigBehavior(senderClient, receiverClient, {
      maxAutoRenewDurationInSeconds: 45,
      receiveClientTimeoutInSeconds: 100,
      delayBeforeAttemptingToReceiveInSeconds: 91,
      expectedIncreaseInLockDurationInSeconds: 60,
      willCompleteFail: true
    });
    // ERROR:
    // Lock expiry time increases by 60 seconds
    // Complete fails after 90 seconds
  });

  it("Receive a msg using Streaming Receiver, lock expires after 300 seconds when config value is undefined", async function(): Promise<
    void
  > {
    await testAutoLockRenewalConfigBehavior(senderClient, receiverClient, {
      maxAutoRenewDurationInSeconds: undefined,
      receiveClientTimeoutInSeconds: 330,
      delayBeforeAttemptingToReceiveInSeconds: 305,
      expectedIncreaseInLockDurationInSeconds: 300,
      willCompleteFail: false
    });
    // ERROR:
    // Lock expiry time increases by 300 seconds
    // Complete does not fail after 300 seconds
  });
});

describe("Unpartitioned Topics/Subscription - Lock Renewal - Peeklock Mode", function(): void {
  let senderClient: QueueClient | TopicClient;
  let receiverClient: QueueClient | SubscriptionClient;
  beforeEach(async () => {
    await beforeEachTest();

    senderClient = unpartitionedTopicClient;
    receiverClient = unpartitionedSubscriptionClient;
  });

  afterEach(async () => {
    await afterEachTest();
  });

  it("renewLock() with Batch Receiver resets lock duration each time.", async function(): Promise<
    void
  > {
    await testBatchReceiverManualLockRenewalHappyCase(senderClient, receiverClient);
  });

  it("Receive a msg using Batch Receiver, wait until its lock expires, completing it now results in error", async function(): Promise<
    void
  > {
    await testBatchReceiverManualLockRenewalErrorOnLockExpiry(senderClient, receiverClient);
  });

  it("Receives a message using Streaming Receiver renewLock() resets lock duration each time.", async function(): Promise<
    void
  > {
    await testStreamingReceiverManualLockRenewalHappyCase(senderClient, receiverClient);
  });

  it("Receive a msg using Streaming Receiver, wait until its lock expires, completing it now results in error", async function(): Promise<
    void
  > {
    await testStreamingReceiverManualLockRenewalErrorOnLockExpiry(senderClient, receiverClient);
  });

  it("Receive a msg using Streaming Receiver, whitebox test on 20 second increment", async function(): Promise<
    void
  > {
    /*
    maxAutoRenewDurationInSeconds: number,
    receiveClientTimeoutInSeconds: number
    */
    await testAutoLockRenewalConfigWhiteBox20SecondIncrement(senderClient, receiverClient, 60, 80);
  });

  it("Receive a msg using Streaming Receiver, lock expires after 30 sec when auto renewal is disabled", async function(): Promise<
    void
  > {
    await testAutoLockRenewalConfigBehavior(senderClient, receiverClient, {
      maxAutoRenewDurationInSeconds: 0,
      receiveClientTimeoutInSeconds: 40,
      delayBeforeAttemptingToReceiveInSeconds: 31,
      expectedIncreaseInLockDurationInSeconds: 20,
      willCompleteFail: false
    });
    // ERROR:
    // Lock still gets renewed, and complete() does not fail
  });

  it("Receive a msg using Streaming Receiver, lock expires after 90 seconds when config value is 45 seconds", async function(): Promise<
    void
  > {
    await testAutoLockRenewalConfigBehavior(senderClient, receiverClient, {
      maxAutoRenewDurationInSeconds: 45,
      receiveClientTimeoutInSeconds: 100,
      delayBeforeAttemptingToReceiveInSeconds: 91,
      expectedIncreaseInLockDurationInSeconds: 80,
      willCompleteFail: false
    });
    // ERROR:
    // Lock expiry time increases by 60 seconds
    // Complete fails after 90 seconds
  });

  it("Receive a msg using Streaming Receiver, lock expires after 300 seconds when config value is undefined", async function(): Promise<
    void
  > {
    await testAutoLockRenewalConfigBehavior(senderClient, receiverClient, {
      maxAutoRenewDurationInSeconds: undefined,
      receiveClientTimeoutInSeconds: 330,
      delayBeforeAttemptingToReceiveInSeconds: 305,
      expectedIncreaseInLockDurationInSeconds: 300,
      willCompleteFail: false
    });
    // ERROR:
    // Lock expiry time increases by 300 seconds
    // Complete does not fail after 300 seconds
  });
});
