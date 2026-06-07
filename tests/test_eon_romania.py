from eon_romania_client import generate_verify_hmac
from integrations.extractors import extract_eon_romania_candidates, infer_source


def test_generate_verify_hmac_is_stable_for_mobile_login():
    assert generate_verify_hmac("user@example.com") == "7d2c2f5d502252c665eac567c7c8ae57"


def test_infer_source_marks_eon_romania_entities():
    assert infer_source("eon_romania:123:sold_factura", "E.ON sold") == "eon_romania"


def test_extract_eon_romania_candidates_exposes_contract_entities():
    payload = {
        "account": {"username": "user@example.com"},
        "contracts": [
            {
                "account_contract": "004412345678",
                "summary": {"accountContract": "004412345678", "utilityType": "GN"},
                "contract_details": {
                    "accountContract": "004412345678",
                    "consumptionPointCode": "NLC123",
                    "distributorName": "Delgaz Grid",
                    "consumptionPointAddress": {
                        "streetName": [{"label": "Strada Florilor", "value": "STREET"}],
                        "streetNumber": "15",
                        "locality": {"label": "Cluj-Napoca", "value": "CITY"},
                        "countyName": "Cluj",
                    },
                },
                "invoice_balance": {"balancePay": True, "totalBalance": 125.5},
                "invoices_unpaid": [
                    {"invoiceNumber": "F1", "balanceValue": 125.5, "maturityDate": "2026-05-10"}
                ],
                "meter_index": {
                    "readingPeriod": {"inPeriod": True},
                    "indexDetails": {
                        "devices": [
                            {
                                "deviceNumber": "MTR1",
                                "indexes": [{"currentIndex": 6030, "utilityType": "GN"}],
                            }
                        ]
                    },
                },
                "consumption_convention": [
                    {"unitMeasure": "m3", "conventionLine": {"valueMonth1": 150, "valueMonth2": 120}}
                ],
                "graphic_consumption": {
                    "um": "M3",
                    "consumption": [
                        {"consumptionValue": 109.89, "year": "2026", "month": "04", "yearMonth": "202604", "consumptionValueDayValue": 3.663},
                        {"consumptionValue": 166.37, "year": "2026", "month": "03", "yearMonth": "202603", "consumptionValueDayValue": 5.367},
                    ],
                },
                "payments": [
                    {"paymentDate": "2026-05-11", "value": 125.5, "paymentChannel": "Card"}
                ],
            }
        ],
    }

    items = extract_eon_romania_candidates(payload)
    by_id = {item["unique_id"]: item for item in items}

    assert by_id["eon_romania:004412345678:sold_factura"]["state"] == "125,5"
    assert by_id["eon_romania:004412345678:sold_factura"]["unit"] == "lei"
    assert by_id["eon_romania:004412345678:factura_restanta"]["state"] == "125,5"
    assert by_id["eon_romania:004412345678:citire_permisa"]["domain"] == "binary_sensor"
    assert any(item["state"] == "6.030" and item["unit"] == "m³" for item in items if ":index_" in item["unique_id"])
    assert by_id["eon_romania:004412345678:consum_total"]["state"] == "276,26"
    assert by_id["eon_romania:004412345678:consum_total"]["unit"] == "m³"
    assert by_id["eon_romania:004412345678:conventie_consum"]["state"] == "135"
    assert by_id["eon_romania:004412345678:plati"]["state"] == "125,5"
    assert by_id["eon_romania:004412345678:sold_factura"]["device_name"] == "E.ON Gaz 5678"
    assert "{" not in by_id["eon_romania:004412345678:sold_factura"]["device_name"]
    assert not any(
        key.startswith("raw") or isinstance(value, (dict, list))
        for item in items
        for key, value in item.get("attributes", {}).items()
    )
    assert all(item["source"] == "eon_romania" for item in items)
    assert by_id["eon_romania:004412345678:date_contract"]["attributes"]["address"] == "Strada Florilor 15, Cluj-Napoca, jud. Cluj"
