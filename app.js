const express = require("express");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const Ajv = require("ajv");
const Redis = require("ioredis");
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");

const { Client } = require("@elastic/elasticsearch");
const amqp = require("amqplib");

// Initialize Express App
const app = express();
const port = 3002;
app.use(bodyParser.json());

// Initialize Redis Client (Key/Value Store)
const redis = new Redis({
    host: "localhost",
    port: 6379,
});

// Initialize Elasticsearch Client
const esClient = new Client({ node: "http://localhost:9200" });


async function initializeIndex() {
    try {
        const indexExists = await esClient.indices.exists({ index: "plans" });
        if (!indexExists.body) {
            console.log("⏳ Creating new 'plans' index with join mapping...");
            await esClient.indices.create({
                index: "plans",
                body: {
                    mappings: {
                        properties: {
                            join_field: {
                                type: "join",
                                relations: {
                                    plan: ["linkedPlanService", "plancostshare"],
                                    linkedPlanService: ["childOfLinkedPlanService"]
                                }
                            }
                        }
                    }
                }
            });
            console.log("✅ Created 'plans' index with parent-child mapping.");
        } else {
            console.log("ℹ️ 'plans' index already exists.");
        }
    } catch (err) {
        if (
            err.meta &&
            err.meta.body &&
            err.meta.body.error &&
            err.meta.body.error.type === "resource_already_exists_exception"
        ) {
            console.warn("⚠️ Tried to create 'plans' index, but it already exists.");
        } else {
            console.error("❌ Error creating 'plans' index:", err);
        }
    }

}


// Initialize RabbitMQ Connection
let channel;
async function setupQueue() {
    try {
        const connection = await amqp.connect("amqp://localhost");
        channel = await connection.createChannel();
        await channel.assertQueue("indexingQueue", { durable: true });

        console.log("✅ RabbitMQ connected. Queue 'indexingQueue' is ready.");

        // Start consuming messages only after the queue is ready
        consumeQueue();
    } catch (error) {
        console.error("❌ RabbitMQ Connection Error:", error);
    }
}

// Google OAuth2 Authentication
const client = new OAuth2Client(
    "775569811341-913kj5dhjqvsbsvt6ao6qk6i40400m4c.apps.googleusercontent.com"
);

// JSON Schema for Validation
const schema = {
    type: "object",
    properties: {
        planCostShares: {
            type: "object",
            properties: {
                deductible: { type: "number" },
                _org: { type: "string" },
                copay: { type: "number" },
                objectId: { type: "string" },
                objectType: { type: "string" },
            },
            required: ["deductible", "_org", "copay", "objectId", "objectType"],
        },
        linkedPlanServices: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    linkedService: {
                        type: "object",
                        properties: {
                            _org: { type: "string" },
                            objectId: { type: "string" },
                            objectType: { type: "string" },
                            name: { type: "string" },
                        },
                        required: ["_org", "objectId", "objectType", "name"],
                    },
                    planserviceCostShares: {
                        type: "object",
                        properties: {
                            deductible: { type: "number" },
                            _org: { type: "string" },
                            copay: { type: "number" },
                            objectId: { type: "string" },
                            objectType: { type: "string" },
                        },
                        required: ["deductible", "_org", "copay", "objectId", "objectType"],
                    },
                    _org: { type: "string" },
                    objectId: { type: "string" },
                    objectType: { type: "string" },
                },
                required: ["linkedService", "planserviceCostShares", "_org", "objectId", "objectType"],
            },
        },
        _org: { type: "string" },
        objectId: { type: "string" },
        objectType: { type: "string" },
        planType: { type: "string" },
        creationDate: { type: "string" },
    },
    required: ["planCostShares", "linkedPlanServices", "_org", "objectId", "objectType", "planType", "creationDate"],
};


// Initialize AJV
const ajv = new Ajv();
const validate = ajv.compile(schema);

// Generate ETag
const generateEtag = (data) => {
    return crypto.createHash("md5").update(JSON.stringify(data)).digest("hex");
};

// Middleware for OAuth Token Verification
const verifyGoogleToken = async (req, res, next) => {
    // Extract the token from the Authorization header
    const token = req.header("Authorization")?.replace("Bearer ", "");
    if (!token) {
        return res.status(403).json({ error: "Authorization token missing" });
    }

    try {
        // Verify the ID token using Google's OAuth2Client
        const ticket = await client.verifyIdToken({
            idToken: token,
            audience: '775569811341-913kj5dhjqvsbsvt6ao6qk6i40400m4c.apps.googleusercontent.com',
        });

        // Get the payload (user info) from the verified ID token
        const payload = ticket.getPayload();

        // Attach the payload (user info) to the request object
        req.user = payload;

        // Continue to the next middleware/route handler
        next();
    } catch (error) {
        return res.status(500).json({
            error: "Token verification failed",
            details: error.message,
        });
    }
};

// CREATE: Store Data in Redis & Index in Elasticsearch
app.post("/v1/plan", verifyGoogleToken, async (req, res) => {
    const data = req.body;
    if (!validate(data)) {
        return res.status(400).json({ error: "Validation failed", details: validate.errors });
    }

    const etag = generateEtag(data);
    data.etag = etag;

    // Store in Redis (Key: objectId, Value: JSON String)
    await redis.set(data.objectId, JSON.stringify(data));

    // Queue indexing operation
    channel.sendToQueue("indexingQueue", Buffer.from(JSON.stringify(data)));

    res.set({
        "X-Powered-By": "Express",
        "Etag": etag,
        "Content-Type": "application/json",
    });

    return res.status(201).json({ id: data.objectId, message: "Plan created successfully" });
});



app.patch("/v1/plan/:id", verifyGoogleToken, async (req, res) => {
    const planId = req.params.id;
    const data = req.body;

    // Retrieve the current plan from Redis
    const planData = await redis.get(planId);

    if (!planData) {
        return res.status(404).json({ error: "Plan not found" });
    }

    let plan = JSON.parse(planData);

    // Get If-Match ETag from the request header
    const clientEtag = req.header("If-Match");

    // If ETag does not match, reject the update
    if (!clientEtag || clientEtag !== plan.etag) {
        return res.status(412).json({ error: "ETag mismatch. The resource has been modified." });
    }

    // Merge the updated fields into the existing plan
    Object.keys(data).forEach((key) => {
        if (Array.isArray(data[key]) && Array.isArray(plan[key])) {
            // Merge array elements based on objectId
            data[key].forEach((updatedItem) => {
                const existingItemIndex = plan[key].findIndex(item => item.objectId === updatedItem.objectId);
                if (existingItemIndex !== -1) {
                    // Merge updated fields for existing objects
                    plan[key][existingItemIndex] = { ...plan[key][existingItemIndex], ...updatedItem };
                } else {
                    // Add new object if not found
                    plan[key].push(updatedItem);
                }
            });
        } else {
            // Directly update scalar or object fields
            plan[key] = data[key];
        }
    });

    // Regenerate the ETag for the updated plan
    const newEtag = generateEtag(plan);
    plan.etag = newEtag;  // Ensure the etag is included in the stored plan

    // Store the updated plan back in Redis
    await redis.set(planId, JSON.stringify(plan));

    // Queue indexing operation for Elasticsearch
    channel.sendToQueue("indexingQueue", Buffer.from(JSON.stringify(plan)));

    res.set({
        "X-Powered-By": "Express",
        "Etag": newEtag,
        "Content-Type": "application/json",
    });

    return res.status(200).json(plan);
});

// GET: Retrieve Data from Redis
app.get("/v1/plan/:id", verifyGoogleToken, async (req, res) => {
    const planData = await redis.get(req.params.id);

    if (!planData) {
        return res.status(404).json({ error: "Plan not found" });
    }

    const plan = JSON.parse(planData);
    const clientEtag = req.header("If-None-Match");

    if (clientEtag && clientEtag === plan.etag) {
        return res.status(304).end();  // If the ETag matches, return 304 NOT MODIFIED
    }

    res.set({
        "X-Powered-By": "Express",
        "Etag": plan.etag,
        "Content-Type": "application/json",
    });

    return res.status(200).json(plan);  // Return the plan with the ETag
});


app.delete("/v1/plan/:id", verifyGoogleToken, async (req, res) => {
    const planId = req.params.id;
    const data = req.body;

    // Check Redis for existence
    const planData = await redis.get(planId);
    if (!planData) {
        return res.status(404).json({ error: "Plan not found" });
    }

    const plan = JSON.parse(planData);

    // 🔁 Cascading delete from Redis: delete linked services
    if (plan.linkedPlanServices) {
        for (const service of plan.linkedPlanServices) {
            await redis.del(service.objectId);
        }
    }

    // 🧹 Delete plan from Redis
    await redis.del(planId);

    // 🔥 Delete plan and ALL children in Elasticsearch
    try {
        await esClient.deleteByQuery({
            index: "plans",
            body: {
                query: {
                    bool: {
                        should: [
                            { term: { "_id": planId } }, // delete the plan itself
                            { term: { "join_field.parent": planId } } // delete children
                        ]
                    }
                }
            },
            routing: planId // Required to route the delete query correctly
        });

        // 🧼 Optionally: delete any grandchildren
        if (plan.linkedPlanServices) {
            for (const service of plan.linkedPlanServices) {
                await esClient.deleteByQuery({
                    index: "plans",
                    body: {
                        query: {
                            term: { "join_field.parent": service.objectId }
                        }
                    },
                    routing: service.objectId
                });
            }
        }

        channel.sendToQueue("indexingQueue", Buffer.from(JSON.stringify(data)));


        return res.status(204).end();
    } catch (error) {
        console.error("❌ Elasticsearch deletion error:", error);
        return res.status(500).json({ error: "Failed to delete from Elasticsearch", details: error.message });
    }
});


// SEARCH: Query Data in Elasticsearch
app.get("/v1/search", verifyGoogleToken, async (req, res) => {
    const query = req.query.q;
    
    const result = await esClient.search({
        index: "plans",
        body: {
            query: {
                match: { planType: query }
            }
        }
    });

    res.json(result.hits.hits.map(hit => hit._source));
});


// Initialize Elasticsearch index for parent-child support
async function consumeQueue() {
    if (!channel) {
        console.error("❌ RabbitMQ channel not initialized.");
        return;
    }

    channel.consume("indexingQueue", async (msg) => {
        if (msg !== null) {
            const data = JSON.parse(msg.content.toString());

            // Index parent "plan"
            await esClient.index({
                index: "plans",
                id: data.objectId,
                body: {
                    ...data,
                    join_field: "plan"
                }
            });

            // ✅ Index planCostShares as a child of plan
            if (data.planCostShares) {
                await esClient.index({
                    index: "plans",
                    id: data.planCostShares.objectId,
                    routing: data.objectId,
                    body: {
                        ...data.planCostShares,
                        join_field: {
                            name: "plancostshare",
                            parent: data.objectId
                        }
                    }
                });
            }

            // ✅ Index each linkedPlanService as a child of plan
            if (data.linkedPlanServices && Array.isArray(data.linkedPlanServices)) {
                for (const service of data.linkedPlanServices) {
                    await esClient.index({
                        index: "plans",
                        id: service.objectId,
                        routing: data.objectId,
                        body: {
                            ...service,
                            join_field: {
                                name: "linkedPlanService",
                                parent: data.objectId
                            }
                        }
                    });

                    // Example child doc under linkedPlanService
                    await esClient.index({
                        index: "plans",
                        id: `${service.objectId}-child`,
                        routing: service.objectId,
                        body: {
                            dummyField: "child doc under linkedPlanService",
                            join_field: {
                                name: "childOfLinkedPlanService",
                                parent: service.objectId
                            }
                        }
                    });
                }
            }

            channel.ack(msg);
        }
    });
}
// consumeQueue();

initializeIndex().catch(console.error);

// Ensure the queue is set up before the server starts
setupQueue();

// Start the Express server
app.listen(port, () => {
    console.log(`🚀 Server running at http://localhost:${port}`);
});