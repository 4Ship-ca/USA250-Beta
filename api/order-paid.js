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

    // Cache the data
    templateCache = templateData;
    templateCacheTime = now;

    return templateData;
}

// Find the templateVariantId that matches the ordered product
function findMatchingVariant(template, gelatoUid) {
    if (!template.variants) {
        console.warn('[TEMPLATE] ⚠️ No variants in template data');
        return null;
    }

    // Try to find exact match by product UID
    const matchedVariant = template.variants.find(v => v.uid === gelatoUid);

    if (matchedVariant) {
        console.log('[TEMPLATE] Found matching variant:', {
            uid: matchedVariant.uid,
            label: matchedVariant.label,
            templateVariantId: matchedVariant.templateVariantId || matchedVariant.id
        });
        return matchedVariant.templateVariantId || matchedVariant.id;
    }

    console.warn('[TEMPLATE] ⚠️ No variant found matching UID:', gelatoUid);
    console.log('[TEMPLATE] Available variants:', template.variants.map(v => ({
        uid: v.uid,
        label: v.label,
        id: v.id || v.templateVariantId
    })));

    return null;
}

// Verify webhook signature
async function verifyWebhook(req) {
    const hmac = req.headers['x-shopify-hmac-sha256'];

    if (!hmac) return false;

    const chunks = [];
    for await (const chunk of req) {
        chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);

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

        // Verify webhook (temporarily disabled for debugging)
        const isValid = await verifyWebhook(req);
        if (!isValid) {
            console.warn('[WEBHOOK] ⚠️ Webhook signature verification failed - proceeding anyway (debug mode)');
        } else {
            console.log('[WEBHOOK] ✅ Webhook signature verified');
        }

        // Parse order
        const chunks = [];
        for await (const chunk of req) {
            chunks.push(chunk);
        }
        const body = Buffer.concat(chunks).toString();
        const order = JSON.parse(body);

        console.log('[WEBHOOK] 📦 Order received:', order.order_number);
        console.log('[WEBHOOK] Total line items:', order.line_items.length);

        // Extract line items
        for (const item of order.line_items) {
            console.log(`[WEBHOOK] Processing line item ${item.id}...`);
            console.log('[WEBHOOK] Item properties:', JSON.stringify(item.properties, null, 2));

            // Get custom attributes
            // Handle both array format (from webhooks) and object format
            let designUrl, gelatoUid;

            if (Array.isArray(item.properties)) {
                // Webhook format: array of {name, value}
                designUrl = item.properties?.find(p => p.name === '_design_url')?.value;
                gelatoUid = item.properties?.find(p => p.name === 'gelato_product')?.value;
            } else if (item.properties && typeof item.properties === 'object') {
                // Object format: direct properties
                designUrl = item.properties._design_url;
                gelatoUid = item.properties.gelato_product;
            }

            console.log('[WEBHOOK] Extracted values:', {
                designUrl: designUrl ? '✅ Found' : '❌ Missing',
                gelatoUid: gelatoUid ? '✅ Found' : '❌ Missing'
            });

            if (!designUrl || !gelatoUid) {
                console.error('[WEBHOOK] ❌ Missing required properties for item:', item.id);
                console.error('[WEBHOOK] designUrl:', designUrl);
                console.error('[WEBHOOK] gelatoUid:', gelatoUid);
                continue;
            }

            console.log('[WEBHOOK] 🎨 Design URL:', designUrl.substring(0, 80) + '...');
            console.log('[WEBHOOK] 🏭 Gelato UID:', gelatoUid);

            // Create Gelato order
            try {
                // Fetch template details to get variant ID
                const template = await getTemplateDetails();
                const templateVariantId = findMatchingVariant(template, gelatoUid);

                if (!templateVariantId) {
                    throw new Error(`Could not find template variant for Gelato UID: ${gelatoUid}`);
                }

                const gelatoOrder = await createGelatoOrder({
                    orderNumber: order.order_number,
                    lineItemId: item.id,
                    quantity: item.quantity,
                    gelatoUid: gelatoUid,
                    templateVariantId: templateVariantId,
                    designUrl: designUrl,
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
    const orderPayload = {
        orderReferenceId: `${data.orderNumber}-${data.lineItemId}`,
        orderType: 'order',
        customerReferenceId: data.orderNumber,
        items: [{
            itemReferenceId: data.lineItemId.toString(),
            templateUid: TEMPLATE_UID,
            variantUid: data.templateVariantId,  // Specify the exact variant
            quantity: data.quantity,
            placeholders: [
                {
                    name: 'customer_image.png',  // Matches the layer name in the Gelato template
                    fileUrl: data.designUrl  // Customer's Cloudinary image URL
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

    console.log('[GELATO] 📤 Sending order to Gelato...');
    console.log('[GELATO] Template UID:', TEMPLATE_UID);
    console.log('[GELATO] Variant UID:', data.templateVariantId);
    console.log('[GELATO] Payload:', JSON.stringify(orderPayload, null, 2));
    console.log('[GELATO] Placeholder being used:', orderPayload.items[0].placeholders[0].name);
    console.log('[GELATO] Image URL being sent:', orderPayload.items[0].placeholders[0].fileUrl);

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
    console.log('[GELATO] Response:', JSON.stringify(responseData, null, 2));

    if (!response.ok) {
        console.error('[GELATO] ❌ API Error:', {
            status: response.status,
            message: responseData.message,
            details: responseData.details
        });
        throw new Error(`Gelato API error: ${response.status} - ${JSON.stringify(responseData)}`);
    }

    console.log('[GELATO] ✅ Successfully sent to Gelato');
    return responseData;
}
