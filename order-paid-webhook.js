// api/webhooks/order-paid.js
import crypto from 'crypto';

const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const GELATO_API_KEY = process.env.GELATO_API_KEY;

// HARDCODED TEST IMAGE - Use this to verify customer payloads vs template placeholders
// Replace with actual customer design URL from Cloudinary in production
const TEST_DESIGN_URL = 'https://res.cloudinary.com/dqab444bd/image/upload/v1738352400/usa250-orders/test_customer_design.png';

export const config = {
    api: {
        bodyParser: false
    }
};

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
        // Verify webhook
        const isValid = await verifyWebhook(req);
        if (!isValid) {
            console.error('Invalid webhook signature');
            return res.status(401).json({ error: 'Unauthorized' });
        }

        // Parse order
        const chunks = [];
        for await (const chunk of req) {
            chunks.push(chunk);
        }
        const body = Buffer.concat(chunks).toString();
        const order = JSON.parse(body);

        console.log('Received order:', order.order_number);

        // Extract line items
        for (const item of order.line_items) {
            // Get custom attributes
            const designUrl = item.properties?.find(p => p.name === '_design_url')?.value;
            const gelatoUid = item.properties?.find(p => p.name === 'gelato_product')?.value;

            if (!designUrl || !gelatoUid) {
                console.error('Missing design URL or Gelato UID for item:', item.id);
                continue;
            }

            console.log('Processing item:', {
                lineItemId: item.id,
                gelatoUid: gelatoUid,
                designUrl: designUrl
            });

            // Create Gelato order
            const gelatoOrder = await createGelatoOrder({
                orderNumber: order.order_number,
                lineItemId: item.id,
                quantity: item.quantity,
                gelatoUid: gelatoUid,
                designUrl: designUrl,  // Uses actual customer design from Cloudinary
                shippingAddress: order.shipping_address
            });

            console.log('Gelato order created:', gelatoOrder.id);
        }

        return res.status(200).json({ success: true });

    } catch (error) {
        console.error('Webhook error:', error);
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
            templateUid: 'f29cdb27-152d-4d38-b6d4-97d915632a6f',  // USA250 template ID
            quantity: data.quantity,
            placeholders: [
                {
                    name: 'customer_image',  // Must match placeholder name in Gelato template
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

    console.log('Creating Gelato order:', JSON.stringify(orderPayload, null, 2));

    const response = await fetch('https://order.gelatoapis.com/v4/orders', {
        method: 'POST',
        headers: {
            'X-API-KEY': GELATO_API_KEY,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(orderPayload)
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Gelato API error: ${response.status} - ${error}`);
    }

    return await response.json();
}
