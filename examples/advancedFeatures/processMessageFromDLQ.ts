import { ServiceBusMessage, Namespace } from "../../lib";
import * as dotenv from "dotenv";
dotenv.config();

const connectionString = process.env.SERVICEBUS_CONNECTION_STRING || "";
const queueName = process.env.QUEUE_NAME || "";
const topicName = process.env.TOPIC_NAME || "";
const subscriptionName = process.env.SUBSCRIPTION_NAME || "";

console.log("Connection string value: ", connectionString);
console.log("Queue name: ", queueName);
console.log("Topic name: ", topicName);
console.log("Subscription name: ", subscriptionName);

const deadLetterQueueName = Namespace.getDeadLetterQueuePathForQueue(queueName);
// const deadLetterQueueName = Namespace.getDeadLetterSubcriptionPathForSubcription(topicName, subscriptionName);

console.log("Dead Letter Queue name: ", deadLetterQueueName);

let ns: Namespace;

/*
  This sample demonstrates retrieving a message from a dead letter queue, editing it and
  sending it back to the main queue.

  Prior to running this sample, run the sample in movingMessagesToDLQ.ts file to move a message
  to the Dead Letter Queue
*/
async function main(): Promise<void> {
  ns = Namespace.createFromConnectionString(connectionString);
  try {
    await processDeadletterMessageQueue();
  } finally {
    await ns.close();
  }
}

async function processDeadletterMessageQueue(): Promise<void> {
  const client = ns.createQueueClient(deadLetterQueueName);

  const message = await client.receiveBatch(1);
  console.log(">>>>> Reprocessing the message in DLQ - ", message);

  if (message.length > 0) {
    // Do something with the message retrieved from DLQ
    await fixAndResendMessage(message[0]);

    // Mark message as complete/processed.
    await message[0].complete();
  } else {
    console.log(">>>> Error: No messages were received from the DLQ.");
  }

  await client.close();
}

// Send repaired message back to the current queue / topic
async function fixAndResendMessage(oldMessage: ServiceBusMessage): Promise<void> {
  // If using Topics, use createTopicClient to send to a topic
  const client = ns.createQueueClient(queueName);

  // Inspect given message and make any changes if necessary
  const repairedMessage = oldMessage.clone();

  await client.send(repairedMessage);
  await client.close();
}

main().catch((err) => {
  console.log("Error occurred: ", err);
});
