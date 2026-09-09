#!/usr/bin/env python3
"""Rotaciona as releases de backup do banco (tags `backup-AAAA-MM-DD`).

Política de retenção escalonada:

- todos os backups dos últimos 30 dias;
- os de segunda-feira, por 180 dias;
- os do primeiro dia do mês, por 730 dias (2 anos);
- os 7 mais recentes são sempre mantidos, independentemente da data.

O que não se encaixa em nenhuma regra é removido (release + tag).
Por segurança, nada é apagado se a política resultar em lista vazia.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from datetime import date, datetime, timezone

PREFIXO = "backup-"
PADRAO_TAG = re.compile(r"^backup-(\d{4})-(\d{2})-(\d{2})$")

DIAS_TODOS = 30
DIAS_SEMANAIS = 180
DIAS_MENSAIS = 730
SEMPRE_MANTER = 7


def manter(tag_data: date, hoje: date) -> bool:
    """Decide se um backup daquela data ainda deve ser mantido."""
    idade = (hoje - tag_data).days
    if idade <= DIAS_TODOS:
        return True
    if tag_data.weekday() == 0 and idade <= DIAS_SEMANAIS:  # segunda-feira
        return True
    if tag_data.day == 1 and idade <= DIAS_MENSAIS:
        return True
    return False


def classificar(tags: list[str], hoje: date) -> tuple[list[str], list[str]]:
    """Separa as tags em (manter, remover), já ordenadas da mais nova para a mais antiga."""
    datadas: list[tuple[date, str]] = []
    for tag in tags:
        casamento = PADRAO_TAG.match(tag)
        if not casamento:
            continue
        ano, mes, dia = (int(parte) for parte in casamento.groups())
        try:
            datadas.append((date(ano, mes, dia), tag))
        except ValueError:
            continue

    datadas.sort(key=lambda item: item[0], reverse=True)

    a_manter: list[str] = []
    a_remover: list[str] = []
    for posicao, (tag_data, tag) in enumerate(datadas):
        if posicao < SEMPRE_MANTER or manter(tag_data, hoje):
            a_manter.append(tag)
        else:
            a_remover.append(tag)
    return a_manter, a_remover


def listar_tags() -> list[str]:
    saida = subprocess.run(
        ["gh", "release", "list", "--limit", "1000", "--json", "tagName"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    return [item["tagName"] for item in json.loads(saida)]


def remover(tag: str) -> None:
    subprocess.run(
        ["gh", "release", "delete", tag, "--yes", "--cleanup-tag"],
        check=True,
        capture_output=True,
        text=True,
    )


def main() -> int:
    hoje = datetime.now(timezone.utc).date()
    tags = [tag for tag in listar_tags() if tag.startswith(PREFIXO)]
    a_manter, a_remover = classificar(tags, hoje)

    print(f"Backups encontrados: {len(tags)}")
    print(f"Mantidos: {len(a_manter)} | A remover: {len(a_remover)}")

    if not a_manter and a_remover:
        print("::error::A política removeria todos os backups. Nada foi apagado.")
        return 1

    for tag in a_remover:
        print(f"Removendo {tag}")
        remover(tag)

    return 0


if __name__ == "__main__":
    sys.exit(main())
