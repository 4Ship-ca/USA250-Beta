import crypto from 'crypto';

const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const GELATO_API_KEY = process.env.GELATO_API_KEY;
const TEMPLATE_UID = '96027505-9403-4ee9-b30c-5e6644f5ac91';

// Cache template details to avoid repeated API calls
let templateCache = null;
let templateCacheTime = 0;
const CACHE_TTL = 3600000; // 1 hour

export const config = {
    api: {
        bodyParser: false
    }
};

// Fetch and cache template details from Gelato
async function getTemplateDetails() {
    const now = Date.now();

    // Return cached data if still valid
    if (templateCache && (now - templateCacheTime) < CACHE_TTL) {
        console.log('[TEMPLATE] Using cached template data');
        return templateCache;
    }

    console.log('[TEMPLATE] Fetching template details from Gelato...');
    const response = await fetch(
        `https://ecommerce.gelatoapis.com/v1/templates/${TEMPLATE_UID}`,
        {
            method: 'GET',
            headers: {
                'X-API-KEY': GELATO_API_KEY,
                'Content-Type': 'application/json'
            }
        }
    );

    if (!response.ok) {
        const errorData = await response.json();
        console.error('[TEMPLATE] ❌ Failed to fetch template:', errorData);
        throw new Error(`Failed to fetch template: ${response.status}`);
    }

    const templateData = await response.json();
    console.log('[TEMPLATE] ✅ Template fetched successfully');
    console.log('[TEMPLATE] Found', templateData.variants?.length || 0, 'variants');

    // Log available image placeholders
    if (templateData.imagePlaceholders) {
        console.log('[TEMPLATE] 📋 Available image placeholders:', JSON.stringify(templateData.imagePlaceholders, null, 2));
    } else {
        console.warn('[TEMPLATE] ⚠️ No imagePlaceholders field in template response');
    }

    // Log template structure to debug
    console.log('[TEMPLATE] 🔍 Full template keys:', Object.keys(templateData));

    // Check for printAreas
    if (templateData.printAreas) {
        console.log('[TEMPLATE] 📍 Found printAreas:', JSON.stringify(templateData.printAreas, null, 2));
    }

    // Check for placeholders in variant level
    if (templateData.variants && templateData.variants[0]) {
        console.log('[TEMPLATE] 🔍 First variant keys:', Object.keys(templateData.variants[0]));
        if (templateData.variants[0].imagePlaceholders) {
            console.log('[TEMPLATE] 📋 Found placeholders in variant:', JSON.stringify(templateData.variants[0].imagePlaceholders, null, 2));
        }
        if (templateData.variants[0].printAreas) {
            console.log('[TEMPLATE] 📍 Found printAreas in variant:', JSON.stringify(templateData.variants[0].printAreas, null, 2));
        }
    }

    // Cache the data
    templateCache = templateData;
    templateCacheTime = now;

    return templateData;
}

// Find the templateVariantId that matches the ordered product
function findMatchingVariant(template, gelatoUid, variantKey) {
    if (!template.variants) {
        console.warn('[TEMPLATE] ⚠️ No variants in template data');
        console.log('[TEMPLATE] Falling back to gelatoUid as variantUid');
        return gelatoUid;
    }

    // Try to find exact match by product UID
    const matchedVariant = template.variants.find(v => v.productUid === gelatoUid);

    if (matchedVariant) {
        console.log('[TEMPLATE] Found matching variant by UID:', {
            uid: matchedVariant.uid,
            label: matchedVariant.label,
            id: matchedVariant.id
        });
        return matchedVariant.id;
    }

    console.warn('[TEMPLATE] ⚠️ No variant found matching UID:', gelatoUid);

    // Try to match by variant key if available
    if (variantKey && template.variants.length > 0) {
        console.log('[TEMPLATE] ℹ️ Attempting to match by variant key:', variantKey);

        // Parse variant key: format is "tee-{color}-{size}" e.g., "tee-navy-xl"
        const keyParts = variantKey.split('-');
        if (keyParts.length >= 3) {
            const productType = keyParts[0];  // "tee"
            const color = keyParts[1];         // "navy"
            const size = keyParts.slice(2).join('-'); // "xl" or "2xl"

            console.log('[TEMPLATE] Parsed variant key:', { productType, color, size });

            // Find variant with matching color and size in variantOptions
            for (const variant of template.variants) {
                if (!variant.variantOptions || variant.variantOptions.length === 0) {
                    continue;
                }

                // Check if this variant's options match our color and size
                const optionValues = variant.variantOptions.map(opt => opt.value?.toLowerCase?.() || '');
                const colorMatch = optionValues.some(val => val.includes(color.toLowerCase()));
                const sizeMatch = optionValues.some(val => val.includes(size.toLowerCase()));

                if (colorMatch && sizeMatch) {
                    console.log('[TEMPLATE] ✅ Found matching variant by key:', {
                        variantKey,
                        matchedId: variant.id,
                        productUid: variant.productUid,
                        title: variant.title,
                        variantOptions: variant.variantOptions
                    });

                    // Log ALL fields in the matched variant for debugging
                    console.log('[TEMPLATE] 🔍 Full matched variant structure:', JSON.stringify(variant, null, 2));

                    // Return productUid - Gelato API expects semantic product identifier for variantUid, not the internal ID
                    console.log('[TEMPLATE] ℹ️ Using productUid for Gelato order:', variant.productUid);
                    return variant.productUid;
                }
            }

            console.warn('[TEMPLATE] ⚠️ Could not find variant matching key:', { color, size });
            console.log('[TEMPLATE] Available variants with options:', JSON.stringify(
                template.variants.map(v => ({
                    id: v.id,
                    title: v.title,
                    variantOptions: v.variantOptions
                })),
                null,
                2
            ));
        } else {
            console.warn('[TEMPLATE] ⚠️ Invalid variant key format:', variantKey);
        }
    }

    // Last resort: use first variant as fallback
    if (template.variants.length > 0) {
        console.log('[TEMPLATE] ℹ️ Using first variant ID as fallback');
        return template.variants[0].id;
    }

    // Fallback: use gelatoUid directly
    console.log('[TEMPLATE] ℹ️ Falling back to gelatoUid as variantUid:', gelatoUid);
    return gelatoUid;
}

// Verify webhook signature
async function verifyWebhook(req, body) {
    const hmac = req.headers['x-shopify-hmac-sha256'];

    if (!hmac) return false;

    const hash = crypto
        .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
        .update(body)
        .digest('base64');

    return crypto.timingSafeEqual(
        Buffer.from(hash),
        Buffer.from(hmac)
    );
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        console.log('[WEBHOOK] ===== NEW ORDER WEBHOOK RECEIVED =====');

        // Read request body once
        const chunks = [];
        for await (const chunk of req) {
            chunks.push(chunk);
        }
        const bodyBuffer = Buffer.concat(chunks);
        const bodyString = bodyBuffer.toString();

        // Verify webhook
        const isValid = await verifyWebhook(req, bodyBuffer);
        if (!isValid) {
            console.warn('[WEBHOOK] ⚠️ Webhook signature verification failed - proceeding anyway (debug mode)');
        } else {
            console.log('[WEBHOOK] ✅ Webhook signature verified');
        }

        // Parse order
        const order = JSON.parse(bodyString);

        console.log('[WEBHOOK] 📦 Order received:', order.order_number);
        console.log('[WEBHOOK] Total line items:', order.line_items.length);

        // Extract line items
        for (const item of order.line_items) {
            console.log(`[WEBHOOK] Processing line item ${item.id}...`);
            console.log('[WEBHOOK] Item properties:', JSON.stringify(item.properties, null, 2));

            // Get custom attributes
            // Handle both array format (from webhooks) and object format
            let designUrl, gelatoUid, variantKey;

            if (Array.isArray(item.properties)) {
                // Webhook format: array of {name, value}
                designUrl = item.properties?.find(p => p.name === '_design_url')?.value;
                gelatoUid = item.properties?.find(p => p.name === 'gelato_product')?.value;
                variantKey = item.properties?.find(p => p.name === '_variant_key')?.value;
            } else if (item.properties && typeof item.properties === 'object') {
                // Object format: direct properties
                designUrl = item.properties._design_url;
                gelatoUid = item.properties.gelato_product;
                variantKey = item.properties._variant_key;
            }

            console.log('[WEBHOOK] Extracted values:', {
                designUrl: designUrl ? '✅ Found' : '❌ Missing',
                gelatoUid: gelatoUid ? '✅ Found' : '❌ Missing',
                variantKey: variantKey ? `✅ Found (${variantKey})` : '⚠️ Missing'
            });

            if (!designUrl || !gelatoUid) {
                console.error('[WEBHOOK] ❌ Missing required properties for item:', item.id);
                console.error('[WEBHOOK] designUrl:', designUrl);
                console.error('[WEBHOOK] gelatoUid:', gelatoUid);
                continue;
            }

            console.log('[WEBHOOK] 🎨 Design URL:', designUrl.substring(0, 80) + '...');
            console.log('[WEBHOOK] 🏭 Gelato UID:', gelatoUid);
            if (variantKey) {
                console.log('[WEBHOOK] 🔑 Variant Key:', variantKey);
            }

            // Create Gelato order
            try {
                // Orders v4 API uses productUid directly from line item
                // No need to fetch template for Orders v4 - pass productUid as-is
                const gelatoOrder = await createGelatoOrder({
                    orderNumber: order.order_number,
                    lineItemId: item.id,
                    quantity: item.quantity,
                    gelatoUid: gelatoUid,  // productUid from line item
                    designUrl: designUrl,
                    currency: order.currency || 'CAD',
                    shippingAddress: order.shipping_address
                });

                console.log('[WEBHOOK] ✅ Gelato order created successfully!');
                console.log('[WEBHOOK] Gelato Order ID:', gelatoOrder.id);
                console.log('[WEBHOOK] Gelato Order Status:', gelatoOrder.fulfillmentStatus);
            } catch (gelatoError) {
                console.error('[WEBHOOK] ❌ Failed to create Gelato order:', gelatoError.message);
                throw gelatoError;
            }
        }

        console.log('[WEBHOOK] ===== ORDER PROCESSING COMPLETE =====');
        return res.status(200).json({ success: true });

    } catch (error) {
        console.error('[WEBHOOK] ❌ CRITICAL ERROR:', error.message);
        console.error('[WEBHOOK] Stack trace:', error.stack);
        return res.status(500).json({ error: error.message });
    }
}

async function createGelatoOrder(data) {
    // Orders v4 API requires productUid + files (not templateUid/variantUid/placeholders)
    // Use productUid directly from the line item (gelatoUid)

    const orderPayload = {
        orderReferenceId: `${data.orderNumber}-${data.lineItemId}`,
        orderType: 'order',
        customerReferenceId: data.orderNumber,
        currency: data.currency,  // Required by Gelato API
        items: [{
            itemReferenceId: data.lineItemId.toString(),
            productUid: data.gelatoUid,  // REQUIRED: Use productUid directly from line item
            quantity: data.quantity,
            files: [
                {
                    type: 'default',  // 'default' = primary print area (front for apparel)
                    url: data.designUrl
                }
            ]
        }],
        shipmentMethodUid: 'standard',
        shippingAddress: {
            firstName: data.shippingAddress.first_name || 'Customer',
            lastName: data.shippingAddress.last_name || '',
            addressLine1: data.shippingAddress.address1 || '',
            addressLine2: data.shippingAddress.address2 || '',
            city: data.shippingAddress.city || '',
            postCode: data.shippingAddress.zip || '',
            state: data.shippingAddress.province_code || '',
            country: data.shippingAddress.country_code || 'US',
            email: data.shippingAddress.email || '',
            phone: (data.shippingAddress.phone || '').replace(/\D/g, '')  // Remove non-digits
        }
    };

    console.log('[GELATO] 📤 Sending order to Gelato (Orders v4 API)...');
    console.log('[GELATO] Product UID:', data.gelatoUid);
    console.log('[GELATO] Design URL:', data.designUrl);
    console.log('[GELATO] File type: default (primary print area)');

    console.log('[GELATO] Full payload:', JSON.stringify(orderPayload, null, 2));

    const response = await fetch('https://order.gelatoapis.com/v4/orders', {
        method: 'POST',
        headers: {
            'X-API-KEY': GELATO_API_KEY,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(orderPayload)
    });

    const responseData = await response.json();

    console.log('[GELATO] HTTP Status:', response.status);

    // Log response details
    if (responseData.items && responseData.items[0]) {
        const item = responseData.items[0];
        console.log('[GELATO] Order Item Response:', {
            id: item.id,
            fulfillmentStatus: item.fulfillmentStatus,
            productUid: item.productUid,
            processedFileUrl: item.processedFileUrl,
            files: item.files?.length || 0,
            refusalReason: item.refusalReason
        });

        if (item.fulfillmentStatus === 'not_connected') {
            console.warn('[GELATO] ⚠️ WARNING: Item marked as not_connected');
            console.warn('[GELATO] Verify that productUid exists and is properly connected in Gelato');
        }
    }

    // Log full response for debugging
    console.log('[GELATO] Full response:', JSON.stringify(responseData, null, 2));

    if (!response.ok) {
        console.error('[GELATO] ❌ API Error:', {
            status: response.status,
            message: responseData.message,
            details: responseData.details
        });
        throw new Error(`Gelato API error: ${response.status} - ${JSON.stringify(responseData)}`);
    }

    console.log('[GELATO] ✅ Order successfully sent to Gelato');
    return responseData;
}
