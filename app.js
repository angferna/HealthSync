const express = require("express");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const Ajv = require("ajv");
const Redis = require("ioredis");

const app = express();
const port = 3002;

// Initialize Redis Client
const redis = new Redis({
    host: "localhost",
    port: 6379, // Default Redis port
});

app.use(bodyParser.json());

// JSON Schema for validation
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

// Helper function to generate ETag
const generateEtag = (data) => {
    const hash = crypto.createHash("md5").update(JSON.stringify(data)).digest("hex");
    return hash;
};

// POST: Create a new plan (Stores in Redis)
app.post("/v1/plan", async (req, res) => {
    const data = req.body;
    if (!validate(data)) {
        return res.status(400).json({ error: "Validation failed", details: validate.errors });
    }

    const etag = generateEtag(data);
    data.etag = etag;

    // Store in Redis (Key: objectId, Value: JSON String)
    await redis.set(data.objectId, JSON.stringify(data));

    res.set({
        "X-Powered-By": "Express",
        "Etag": etag,
        "Content-Type": "application/json",
    });

    return res.status(201).json({ id: data.objectId, message: "Plan created successfully" });
});

// GET: Retrieve a plan from Redis
app.get("/v1/plan/:id", async (req, res) => {
    const planData = await redis.get(req.params.id);
    
    if (!planData) {
        return res.status(404).json({ error: "Plan not found" });
    }

    const plan = JSON.parse(planData);
    const clientEtag = req.header("If-None-Match");

    if (clientEtag && clientEtag === plan.etag) {
        return res.status(304).end();
    }

    res.set({
        "X-Powered-By": "Express",
        "Etag": plan.etag,
        "Content-Type": "application/json",
    });

    return res.status(200).json(plan);
});

// DELETE: Remove a plan from Redis
app.delete("/v1/plan/:id", async (req, res) => {
    const planId = req.params.id;
    const deleted = await redis.del(planId);

    if (!deleted) {
        return res.status(404).json({ error: "Plan not found" });
    }

    res.set({ "X-Powered-By": "Express" });

    return res.status(204).end();
});

// Start server
app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
