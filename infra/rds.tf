# ==============================================================================
# RDS POSTGRESQL DATABASE
# ==============================================================================

resource "aws_db_subnet_group" "rds" {
  name        = "${var.project_name}-db-subnet-group"
  description = "Subnet group for RDS PostgreSQL across private subnets"
  subnet_ids  = [aws_subnet.private_1.id, aws_subnet.private_2.id]

  tags = {
    Name = "${var.project_name}-db-subnet-group"
  }
}

# Security group for RDS PostgreSQL instance
resource "aws_security_group" "rds" {
  name        = "${var.project_name}-rds-sg"
  description = "Controls database network access"
  vpc_id      = aws_vpc.main.id

  # Inbound: allow PostgreSQL port 5432 strictly from the ECS task security group.
  # No CIDR block or public internet access allowed.
  ingress {
    description     = "Allow inbound PostgreSQL traffic strictly from ECS Fargate tasks"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs_task.id]
  }

  egress {
    description = "Allow all outbound traffic from database"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.project_name}-rds-sg"
  }
}

resource "aws_db_instance" "postgres" {
  identifier             = "${var.project_name}-db"
  allocated_storage      = 20
  max_allocated_storage  = 20
  storage_type           = "gp3"
  engine                 = "postgres"
  engine_version         = "16.3"
  instance_class         = "db.t3.micro"
  db_name                = "moneyops_v2"
  username               = "postgres"
  password               = var.db_password
  db_subnet_group_name   = aws_db_subnet_group.rds.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = false
  multi_az               = false
  skip_final_snapshot    = true
  deletion_protection    = false

  tags = {
    Name = "${var.project_name}-db"
  }
}
