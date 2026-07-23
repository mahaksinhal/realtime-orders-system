CREATE TABLE IF NOT EXISTS orders (
    id SERIAL PRIMARY KEY,
    customer_name VARCHAR(100),
    product_name VARCHAR(100),
    status VARCHAR(20) CHECK (status IN ('pending', 'shipped', 'delivered')),
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS order_events (
    id SERIAL PRIMARY KEY,
    operation TEXT,
    order_id INT,
    payload JSONB,
    emitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE OR REPLACE FUNCTION notify_order_change()
RETURNS TRIGGER AS $$
DECLARE
    payload_data JSONB;
    order_id_val INT;
    notify_payload JSON;
BEGIN
    IF (TG_OP = 'DELETE') THEN
        order_id_val = OLD.id;
        payload_data = to_jsonb(OLD);
    ELSE
        order_id_val = NEW.id;
        payload_data = to_jsonb(NEW);
    END IF;

    -- Populated by the trigger in the same transaction as pg_notify
    INSERT INTO order_events (operation, order_id, payload)
    VALUES (TG_OP, order_id_val, payload_data);

    -- Construct pg_notify payload compatible with existing WS/listener expectations
    notify_payload = json_build_object(
        'operation', TG_OP,
        'data', payload_data
    );

    PERFORM pg_notify(
        'orders_channel',
        notify_payload::text
    );

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS orders_change_trigger ON orders;
CREATE TRIGGER orders_change_trigger
AFTER INSERT OR UPDATE OR DELETE
ON orders
FOR EACH ROW
EXECUTE FUNCTION notify_order_change();

CREATE OR REPLACE FUNCTION update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_orders_timestamp ON orders;
CREATE TRIGGER update_orders_timestamp
BEFORE UPDATE
ON orders
FOR EACH ROW
EXECUTE FUNCTION update_timestamp();
